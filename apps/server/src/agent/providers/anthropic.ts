import Anthropic from '@anthropic-ai/sdk'
import type { AgentProvider, AgentStreamItem, AgentTurnContext, TranscriptEntry } from '@loom/shared'
import type { ServerConfig } from '../../env'
import { agentSystemPrompt } from '../context'
import { TemplateSummarizer, type CommitSummary, type Summarizer, type SummaryInput } from '../summarizer'
import { AGENT_TOOL_DEFS } from '../tools'

const MAX_TOOL_ROUNDS = 16

/**
 * Real Claude behind the same AgentProvider interface as the mock. Streams
 * text deltas, yields tool_call items, executes them via ctx.executeTool and
 * feeds results back until the model stops calling tools.
 */
export class AnthropicAgentProvider implements AgentProvider {
  private client: Anthropic

  constructor(private opts: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey })
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

    const messages: Anthropic.MessageParam[] = [
      ...transcriptToMessages(ctx.transcript),
      { role: 'user', content: ctx.userMessage },
    ]

    const fullText: string[] = []
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (ctx.signal.aborted) break
        const stream = this.client.messages.stream(
          {
            model: this.opts.model,
            max_tokens: 8192,
            system,
            messages,
            tools: AGENT_TOOL_DEFS,
          },
          { signal: ctx.signal },
        )

        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { kind: 'delta', text: event.delta.text }
          }
        }

        const final = await stream.finalMessage()
        if (final.usage) {
          yield {
            kind: 'usage',
            inputTokens: final.usage.input_tokens ?? 0,
            outputTokens: final.usage.output_tokens ?? 0,
          }
        }
        for (const block of final.content) {
          if (block.type === 'text' && block.text.trim()) {
            fullText.push(block.text)
            yield { kind: 'delta', text: '\n\n' }
          }
        }

        const toolUses = final.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        )
        if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break

        messages.push({ role: 'assistant', content: final.content })
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const tu of toolUses) {
          const input = (tu.input ?? {}) as Record<string, unknown>
          yield { kind: 'tool_call', name: tu.name, input }
          const exec = await ctx.executeTool(tu.name, input)
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: exec.content ?? exec.summary,
            is_error: !exec.ok,
          })
        }
        messages.push({ role: 'user', content: results })
      }
      yield { kind: 'message_done', fullText: fullText.join('\n\n') }
    } catch (err) {
      // a Stop aborts the request mid-stream — keep the partial text, no error
      if (ctx.signal.aborted) {
        if (fullText.length > 0) yield { kind: 'message_done', fullText: fullText.join('\n\n') }
        return
      }
      yield {
        kind: 'error',
        message: `Claude call failed: ${err instanceof Error ? err.message : String(err)}`,
      }
      if (fullText.length > 0) {
        yield { kind: 'message_done', fullText: fullText.join('\n\n') }
      }
    }
  }
}

/**
 * The transcript is rebuilt from persisted events (not raw API messages), so
 * we fold tool entries into the surrounding assistant turns and coalesce
 * consecutive same-role entries to satisfy the alternating-roles contract.
 */
function transcriptToMessages(transcript: TranscriptEntry[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = []
  for (const entry of transcript) {
    const role = entry.role === 'user' ? 'user' : 'assistant'
    const text = entry.role === 'tool' ? `(${entry.text})` : entry.text
    const last = messages[messages.length - 1]
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n${text}`
    } else {
      messages.push({ role, content: text })
    }
  }
  // API requires the conversation to start with a user message
  while (messages.length > 0 && messages[0]!.role !== 'user') messages.shift()
  return messages
}

/** One extra cheap model call per commit for the humanized summaries. */
export class AnthropicSummarizer implements Summarizer {
  private client: Anthropic
  private fallback = new TemplateSummarizer()

  constructor(private opts: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey })
  }

  async summarize(input: SummaryInput): Promise<CommitSummary> {
    try {
      const diffText = input.diffs
        .map((d) => `--- ${d.path} (${d.changeKind}, +${d.additions}/-${d.deletions})\n${d.unifiedDiff}`)
        .join('\n\n')
        .slice(0, 12_000)

      const res = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: `A coding agent just made changes to the "${input.moduleName}" part of the "${input.projectName}" project, because ${input.driverName} asked: "${input.userMessage.slice(0, 400)}".

The diff:
${diffText}

Reply with EXACTLY two lines:
TECHNICAL: <one-line commit summary for developers, imperative mood, ≤80 chars>
PLAIN: <1-2 sentences explaining the change to a non-technical founder. No jargon, no file names unless meaningful, never assume the reader knows git.>`,
          },
        ],
      })

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      const technical = /TECHNICAL:\s*(.+)/i.exec(text)?.[1]?.trim()
      const plain = /PLAIN:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().replace(/\s+/g, ' ')
      if (technical && plain) {
        return { technicalSummary: technical, plainExplanation: plain }
      }
      return this.fallback.summarize(input)
    } catch {
      return this.fallback.summarize(input)
    }
  }
}

/** Conflict resolver for real mode: hand the conflict hunks to the model. */
export function makeAnthropicConflictResolver(config: ServerConfig) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey! })
  return async (filePath: string, conflictedContent: string): Promise<string | null> => {
    try {
      const res = await client.messages.create({
        model: config.anthropicModel,
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: `This file (${filePath}) has git merge conflict markers. Produce the best merged version that keeps the intent of BOTH sides. Reply with ONLY the full resolved file content — no fences, no commentary.

${conflictedContent.slice(0, 40_000)}`,
          },
        ],
      })
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (!text.trim() || /<<<<<<<|>>>>>>>/.test(text)) return null
      return text.replace(/^```[a-z]*\n?/, '').replace(/\n?```\s*$/, '')
    } catch {
      return null
    }
  }
}
