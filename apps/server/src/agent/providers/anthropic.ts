import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { AgentProvider, AgentStreamItem, AgentTurnContext, TranscriptEntry } from '@loom/shared'
import type { ServerConfig } from '../../env'
import { claudeCaps } from '../claudeModels'
import { agentDynamicContext, agentSystemPrompt } from '../context'
import { TemplateSummarizer, type CommitSummary, type Summarizer, type SummaryInput } from '../summarizer'
import { AGENT_TOOL_DEFS } from '../tools'

type BetaMessageParam = Anthropic.Beta.BetaMessageParam
type BetaStreamParams = BetaMessageStreamParams

const MAX_TOOL_ROUNDS = 16
/** thinking counts toward max_tokens; 64K is the recommended room for agentic coding turns */
const AGENT_MAX_TOKENS = 64_000
/** pre-4.6 models have smaller output caps */
const LEGACY_MAX_TOKENS = 16_000
const REQUEST_TIMEOUT_MS = 10 * 60_000
const MAX_RETRIES = 3
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** The slice of the SDK client the provider uses — injectable for tests. */
export interface AgentClient {
  beta: { messages: { stream: Anthropic['beta']['messages']['stream'] } }
}

export function makeClaudeClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: MAX_RETRIES, timeout: REQUEST_TIMEOUT_MS })
}

/**
 * One agent-round request, shaped for what the model accepts. The stable
 * system block carries a cache breakpoint; volatile per-turn context (file
 * tree, session brief) sits after it; the automatic top-level breakpoint
 * advances with the growing tool-round history so every round re-reads the
 * previous one from cache.
 */
export function buildAgentRequest(input: {
  model: string
  effort: string | null | undefined
  system: string
  dynamicContext: string
  messages: BetaMessageParam[]
  tools: BetaStreamParams['tools']
}): BetaStreamParams {
  const caps = claudeCaps(input.model)
  const effort = caps.efforts.find((e) => e === input.effort)
  return {
    model: input.model,
    max_tokens: caps.adaptiveThinking ? AGENT_MAX_TOKENS : LEGACY_MAX_TOKENS,
    system: [
      { type: 'text', text: input.system, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: input.dynamicContext },
    ],
    messages: input.messages,
    tools: input.tools,
    cache_control: { type: 'ephemeral' },
    // current models write their between-tool narration into thinking blocks,
    // empty unless display is requested — teammates would watch silence
    ...(caps.adaptiveThinking
      ? { thinking: caps.summarizedDisplay ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' } }
      : {}),
    ...(effort ? { output_config: { effort } } : {}),
    ...(caps.refusalFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
  } as BetaStreamParams
}

/**
 * Real Claude behind the same AgentProvider interface as the mock. Streams
 * text and thinking deltas, yields tool_call items, executes them via
 * ctx.executeTool and feeds results back until the model stops calling tools.
 * The message history within a turn is append-only (assistant content is
 * replayed verbatim), which keeps both the prompt cache and thinking-block
 * signatures valid across rounds.
 */
export class AnthropicAgentProvider implements AgentProvider {
  private client: AgentClient

  constructor(private opts: { apiKey: string; model: string; effort?: string | null; client?: AgentClient }) {
    this.client = opts.client ?? makeClaudeClient(opts.apiKey)
  }

  async *runTurn(ctx: AgentTurnContext): AsyncIterable<AgentStreamItem> {
    const system = agentSystemPrompt({
      projectName: ctx.projectName,
      moduleName: ctx.moduleName,
      moduleDescription: ctx.moduleDescription,
      driverName: ctx.driverName,
    })
    const dynamicContext = agentDynamicContext(ctx)
    const messages: BetaMessageParam[] = [...transcriptToMessages(ctx.transcript), { role: 'user', content: ctx.userMessage }]

    const fullText: string[] = []
    // partial usage for the in-flight round, so a Stop mid-stream still bills
    // what the provider already charged (finalMessage is authoritative otherwise)
    let pending = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (ctx.signal.aborted) break
        pending = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        const request = buildAgentRequest({
          model: this.opts.model,
          effort: this.opts.effort,
          system,
          dynamicContext,
          messages,
          tools: AGENT_TOOL_DEFS as BetaStreamParams['tools'],
        })
        const stream = this.client.beta.messages.stream(request, { signal: ctx.signal })

        for await (const event of stream) {
          if (event.type === 'message_start') {
            const u = event.message.usage
            pending = {
              input: u?.input_tokens ?? 0,
              output: 0,
              cacheRead: u?.cache_read_input_tokens ?? 0,
              cacheWrite: u?.cache_creation_input_tokens ?? 0,
            }
          } else if (event.type === 'message_delta') {
            pending.output = event.usage?.output_tokens ?? pending.output
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') yield { kind: 'delta', text: event.delta.text }
            else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              yield { kind: 'thinking', text: event.delta.thinking }
            }
          }
        }

        const final = await stream.finalMessage()
        pending = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        if (final.usage) {
          yield {
            kind: 'usage',
            inputTokens: final.usage.input_tokens ?? 0,
            outputTokens: final.usage.output_tokens ?? 0,
            cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
          }
        }
        for (const block of final.content) {
          if (block.type === 'text' && block.text.trim()) {
            fullText.push(block.text)
            yield { kind: 'delta', text: '\n\n' }
          }
        }

        if (final.stop_reason === 'refusal') {
          const category = final.stop_details?.category ?? 'policy'
          yield {
            kind: 'error',
            message: `Claude declined this request (${category} safeguard). Rephrase the request, or pick another model in ⚙ AI provider.`,
          }
          break
        }
        const toolUses = final.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        if (final.stop_reason === 'max_tokens') {
          // a tool input cut off mid-generation can still parse as a valid
          // partial object — never execute it
          yield {
            kind: 'error',
            message: 'The agent hit its output limit mid-step, so its last action was not applied. Ask it to continue in smaller steps.',
          }
          break
        }
        if (final.stop_reason === 'pause_turn') {
          messages.push({ role: 'assistant', content: final.content as BetaMessageParam['content'] })
          continue
        }
        if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break
        // Stop pressed after the model chose tools but before we ran them
        if (ctx.signal.aborted) break

        messages.push({ role: 'assistant', content: final.content as BetaMessageParam['content'] })
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        for (const tu of toolUses) {
          if (ctx.signal.aborted) break // stop between tools in a multi-tool round
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
        // every tool_result in ONE user message — splitting them discourages parallel calls
        messages.push({ role: 'user', content: results })
      }
      yield { kind: 'message_done', fullText: fullText.join('\n\n') }
    } catch (err) {
      // a Stop aborts the request mid-stream — keep the partial text + usage
      if (ctx.signal.aborted) {
        if (pending.input > 0 || pending.output > 0) {
          yield {
            kind: 'usage',
            inputTokens: pending.input,
            outputTokens: pending.output,
            cacheReadTokens: pending.cacheRead,
            cacheWriteTokens: pending.cacheWrite,
          }
        }
        if (fullText.length > 0) yield { kind: 'message_done', fullText: fullText.join('\n\n') }
        return
      }
      yield { kind: 'error', message: describeApiError(err) }
      if (fullText.length > 0) yield { kind: 'message_done', fullText: fullText.join('\n\n') }
    }
  }
}

/** Typed SDK errors → a message a driver can act on (most specific first). */
function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key — update it in ⚙ AI provider.'
  if (err instanceof Anthropic.NotFoundError) return `Anthropic doesn't recognize this model — pick another in ⚙ AI provider. (${err.message.slice(0, 160)})`
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic is rate-limiting this key right now — wait a moment and resend.'
  if (err instanceof Anthropic.APIError) return `Claude call failed (${err.status ?? 'network'}): ${err.message.slice(0, 240)}`
  return `Claude call failed: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * The transcript is rebuilt from persisted events (not raw API messages), so
 * we fold tool entries into the surrounding assistant turns and coalesce
 * consecutive same-role entries to satisfy the alternating-roles contract.
 */
function transcriptToMessages(transcript: TranscriptEntry[]): BetaMessageParam[] {
  const messages: BetaMessageParam[] = []
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

/** Concatenated text blocks of a response (thinking blocks are skipped). */
function responseText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/** Low effort where supported: summaries are short and shouldn't deliberate. */
function lowEffort(model: string): { output_config?: { effort: 'low' } } {
  return claudeCaps(model).efforts.includes('low') ? { output_config: { effort: 'low' } } : {}
}

/** One extra cheap model call per commit for the humanized summaries. */
export class AnthropicSummarizer implements Summarizer {
  private client: Anthropic
  private fallback = new TemplateSummarizer()

  constructor(private opts: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 60_000 })
  }

  async summarize(input: SummaryInput): Promise<CommitSummary> {
    try {
      const diffText = input.diffs
        .map((d) => `--- ${d.path} (${d.changeKind}, +${d.additions}/-${d.deletions})\n${d.unifiedDiff}`)
        .join('\n\n')
        .slice(0, 12_000)

      const res = await this.client.messages.create({
        model: this.opts.model,
        // thinking (on by default on current models) counts toward this
        max_tokens: 4000,
        ...lowEffort(this.opts.model),
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

      const text = responseText(res.content)
      const technical = /TECHNICAL:\s*(.+)/i.exec(text)?.[1]?.trim()
      const plain = /PLAIN:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().replace(/\s+/g, ' ')
      if (technical && plain) {
        return { technicalSummary: technical, plainExplanation: plain }
      }
      console.warn(`[summarizer] ${this.opts.model} reply did not match the two-line format; using template`)
      return this.fallback.summarize(input)
    } catch (err) {
      // a retired/misnamed model fails here on every commit — make it loud
      console.warn(`[summarizer] ${this.opts.model} call failed; using template:`, err instanceof Error ? err.message : err)
      return this.fallback.summarize(input)
    }
  }
}

/** Conflict resolver for real mode: hand the conflict hunks to the model. */
export function makeAnthropicConflictResolver(config: ServerConfig) {
  const client = makeClaudeClient(config.anthropicApiKey!)
  const model = config.anthropicModel
  return async (filePath: string, conflictedContent: string): Promise<string | null> => {
    try {
      // streamed: a whole resolved file plus thinking can exceed non-streaming timeouts
      const res = await client.messages
        .stream({
          model,
          max_tokens: claudeCaps(model).adaptiveThinking ? AGENT_MAX_TOKENS : LEGACY_MAX_TOKENS,
          messages: [
            {
              role: 'user',
              content: `This file (${filePath}) has git merge conflict markers. Produce the best merged version that keeps the intent of BOTH sides. Reply with ONLY the full resolved file content — no fences, no commentary.

${conflictedContent.slice(0, 40_000)}`,
            },
          ],
        })
        .finalMessage()
      if (res.stop_reason === 'max_tokens' || res.stop_reason === 'refusal') return null
      const text = responseText(res.content)
      if (!text.trim() || /<<<<<<<|>>>>>>>/.test(text)) return null
      return text.replace(/^```[a-z]*\n?/, '').replace(/\n?```\s*$/, '')
    } catch (err) {
      console.warn(`[merge] AI conflict resolution failed for ${filePath}:`, err instanceof Error ? err.message : err)
      return null
    }
  }
}
