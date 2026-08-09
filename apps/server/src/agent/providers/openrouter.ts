import type { AgentProvider, AgentStreamItem, AgentTurnContext, TranscriptEntry } from '@loom/shared'
import { agentSystemPrompt } from '../context'
import { TemplateSummarizer, type CommitSummary, type Summarizer, type SummaryInput } from '../summarizer'
import { AGENT_TOOL_DEFS } from '../tools'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const MAX_TOOL_ROUNDS = 16

interface CompatOpts {
  apiKey: string
  model: string
  /** OpenRouter by default; any OpenAI-compatible endpoint works (Ollama, vLLM…). */
  baseUrl?: string
}

interface StreamedToolCall {
  id: string
  name: string
  args: string
}

/**
 * OpenAI-compatible chat-completions provider (OpenRouter et al) behind the
 * same AgentProvider interface as the mock and Anthropic providers. Streams
 * SSE deltas, accumulates tool calls, executes them via ctx.executeTool and
 * loops until the model stops calling tools. No SDK dependency — plain fetch.
 */
export class OpenAICompatProvider implements AgentProvider {
  constructor(private opts: CompatOpts) {}

  private get baseUrl(): string {
    return (this.opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, '')
  }

  async *runTurn(ctx: AgentTurnContext): AsyncIterable<AgentStreamItem> {
    const system = [
      agentSystemPrompt({
        projectName: ctx.projectName,
        moduleName: ctx.moduleName,
        moduleDescription: ctx.moduleDescription,
        driverName: ctx.driverName,
      }),
      '',
      'Current files in the workspace:',
      ctx.fileTree.length > 0 ? ctx.fileTree.map((f) => `- ${f}`).join('\n') : '(empty)',
    ].join('\n')

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: system },
      ...transcriptToMessages(ctx.transcript),
      { role: 'user', content: ctx.userMessage },
    ]
    const tools = AGENT_TOOL_DEFS.map((d) => ({
      type: 'function',
      function: { name: d.name, description: d.description, parameters: d.input_schema },
    }))

    const fullText: string[] = []
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (ctx.signal.aborted) break
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            'content-type': 'application/json',
            // OpenRouter attribution headers (harmless on other endpoints)
            'HTTP-Referer': 'https://github.com/loom-dev/loom',
            'X-Title': 'Loom',
          },
          body: JSON.stringify({ model: this.opts.model, messages, tools, stream: true }),
          signal: ctx.signal,
        })
        if (!res.ok || !res.body) {
          const detail = await safeReadText(res)
          yield { kind: 'error', message: `LLM call failed (${res.status}): ${detail.slice(0, 300)}` }
          if (fullText.length > 0) yield { kind: 'message_done', fullText: fullText.join('\n\n') }
          return
        }

        let roundText = ''
        const toolCalls: StreamedToolCall[] = []
        for await (const data of sseData(res.body)) {
          if (ctx.signal.aborted || data === '[DONE]') break
          let chunk: unknown
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }
          const delta = (chunk as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0]?.delta
          if (!delta) continue
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            roundText += delta.content
            yield { kind: 'delta', text: delta.content }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls as Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>) {
              const idx = tc.index ?? 0
              while (toolCalls.length <= idx) toolCalls.push({ id: '', name: '', args: '' })
              const slot = toolCalls[idx]!
              if (tc.id) slot.id = tc.id
              if (tc.function?.name) slot.name += tc.function.name
              if (tc.function?.arguments) slot.args += tc.function.arguments
            }
          }
        }

        if (roundText.trim()) {
          fullText.push(roundText)
          yield { kind: 'delta', text: '\n\n' }
        }

        const completed = toolCalls.filter((t) => t.name)
        if (completed.length === 0) break

        messages.push({
          role: 'assistant',
          content: roundText || null,
          tool_calls: completed.map((t) => ({
            id: t.id || `call_${Math.abs(hashCode(t.name + t.args))}`,
            type: 'function',
            function: { name: t.name, arguments: t.args || '{}' },
          })),
        })
        for (const call of completed) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(call.args || '{}') as Record<string, unknown>
          } catch {
            input = {}
          }
          yield { kind: 'tool_call', name: call.name, input }
          const exec = await ctx.executeTool(call.name, input)
          messages.push({
            role: 'tool',
            tool_call_id: call.id || `call_${Math.abs(hashCode(call.name + call.args))}`,
            content: exec.content ?? exec.summary,
          })
        }
      }
      yield { kind: 'message_done', fullText: fullText.join('\n\n') }
    } catch (err) {
      // a Stop aborts the fetch mid-stream — keep the partial text, no error
      if (ctx.signal.aborted) {
        if (fullText.length > 0) yield { kind: 'message_done', fullText: fullText.join('\n\n') }
        return
      }
      yield {
        kind: 'error',
        message: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      }
      if (fullText.length > 0) yield { kind: 'message_done', fullText: fullText.join('\n\n') }
    }
  }
}

/** Same alternating-roles folding as the Anthropic provider. */
function transcriptToMessages(transcript: TranscriptEntry[]): Array<Record<string, unknown>> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const entry of transcript) {
    const role = entry.role === 'user' ? 'user' : 'assistant'
    const text = entry.role === 'tool' ? `(${entry.text})` : entry.text
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content = `${last.content}\n${text}`
    else messages.push({ role, content: text })
  }
  while (messages.length > 0 && messages[0]!.role !== 'user') messages.shift()
  return messages
}

/** Minimal SSE reader: yields the payload after each `data:` line. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trimEnd()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ')
  } catch {
    return res.statusText
  }
}

/** Commit summaries through the same endpoint; template fallback on any error. */
export class OpenAICompatSummarizer implements Summarizer {
  private fallback = new TemplateSummarizer()

  constructor(private opts: CompatOpts) {}

  async summarize(input: SummaryInput): Promise<CommitSummary> {
    try {
      const diffText = input.diffs
        .map((d) => `--- ${d.path} (${d.changeKind}, +${d.additions}/-${d.deletions})\n${d.unifiedDiff}`)
        .join('\n\n')
        .slice(0, 12_000)
      const res = await fetch(`${(this.opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: 400,
          messages: [
            {
              role: 'user',
              content: `A coding agent just changed the "${input.moduleName}" part of "${input.projectName}" because ${input.driverName} asked: "${input.userMessage.slice(0, 400)}".

The diff:
${diffText}

Reply with EXACTLY two lines:
TECHNICAL: <one-line commit summary for developers, imperative mood, ≤80 chars>
PLAIN: <1-2 sentences for a non-technical founder. No jargon, no git terms.>`,
            },
          ],
        }),
      })
      if (!res.ok) return this.fallback.summarize(input)
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = json.choices?.[0]?.message?.content ?? ''
      const technical = /TECHNICAL:\s*(.+)/i.exec(text)?.[1]?.trim()
      const plain = /PLAIN:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().replace(/\s+/g, ' ')
      if (technical && plain) return { technicalSummary: technical, plainExplanation: plain }
      return this.fallback.summarize(input)
    } catch {
      return this.fallback.summarize(input)
    }
  }
}

/** Merge-conflict resolver through the same endpoint. */
export function makeOpenAICompatConflictResolver(opts: CompatOpts) {
  return async (filePath: string, conflictedContent: string): Promise<string | null> => {
    try {
      const res = await fetch(`${(opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            {
              role: 'user',
              content: `This file (${filePath}) has git merge conflict markers. Produce the best merged version keeping the intent of BOTH sides. Reply with ONLY the full resolved file content — no fences, no commentary.

${conflictedContent.slice(0, 40_000)}`,
            },
          ],
        }),
      })
      if (!res.ok) return null
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = json.choices?.[0]?.message?.content ?? ''
      if (!text.trim() || /<<<<<<<|>>>>>>>/.test(text)) return null
      return text.replace(/^```[a-z]*\n?/, '').replace(/\n?```\s*$/, '')
    } catch {
      return null
    }
  }
}

/**
 * Cheap live validation used when a key is pasted in the UI: one 1-token
 * completion proves key + model + endpoint in a single round trip.
 */
export async function validateOpenAICompat(opts: CompatOpts): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${(opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    if (res.ok) return { ok: true }
    const detail = await safeReadText(res)
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'That API key was rejected by the provider.' }
    if (res.status === 404 || /model/i.test(detail)) return { ok: false, error: `The provider rejected the model id: ${detail.slice(0, 200)}` }
    return { ok: false, error: `Provider check failed (${res.status}): ${detail.slice(0, 200)}` }
  } catch (err) {
    return { ok: false, error: `Could not reach the provider: ${err instanceof Error ? err.message : String(err)}` }
  }
}
