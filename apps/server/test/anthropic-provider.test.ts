import { describe, expect, it } from 'vitest'
import type { AgentStreamItem, AgentToolExecution, AgentTurnContext } from '@loom/shared'
import { AnthropicAgentProvider, buildAgentRequest } from '../src/agent/providers/anthropic'

/** One scripted API round: the stream events + the final message. */
interface Round {
  events: Array<Record<string, unknown>>
  final: Record<string, unknown>
}

/** Minimal stand-in for the SDK client: records requests, replays rounds. */
function fakeClient(rounds: Round[]) {
  const requests: Array<Record<string, unknown>> = []
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          // snapshot: the provider keeps appending to its messages array
          requests.push(structuredClone(params))
          const round = rounds.shift()
          if (!round) throw new Error('fake client ran out of scripted rounds')
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of round.events) yield e
            },
            finalMessage: async () => round.final,
          }
        },
      },
    },
  }
  return { client, requests }
}

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

function ctx(overrides: Partial<AgentTurnContext> = {}): AgentTurnContext & { calls: string[] } {
  const calls: string[] = []
  return {
    sessionId: 's1',
    projectName: 'Nimbus',
    moduleName: 'Landing',
    moduleDescription: 'the marketing site',
    driverName: 'Ayan',
    userMessage: 'Add a footer',
    transcript: [],
    fileTree: ['index.html'],
    turnIndex: 0,
    signal: new AbortController().signal,
    executeTool: async (name: string): Promise<AgentToolExecution> => {
      calls.push(name)
      return { summary: `ran ${name}`, ok: true, content: 'ok' }
    },
    calls,
    ...overrides,
  }
}

async function collect(it: AsyncIterable<AgentStreamItem>): Promise<AgentStreamItem[]> {
  const out: AgentStreamItem[] = []
  for await (const item of it) out.push(item)
  return out
}

describe('buildAgentRequest — request shape per model', () => {
  const base = { system: 'STATIC', dynamicContext: 'files: index.html', messages: [], tools: [] }

  it('current models: adaptive thinking with summarized display, effort, fallbacks, caching', () => {
    const req = buildAgentRequest({ ...base, model: 'claude-opus-5-5', effort: 'high' })
    expect(req.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(req.output_config).toEqual({ effort: 'high' })
    expect(req.fallbacks).toBe('default')
    expect(req.betas).toContain('server-side-fallback-2026-07-01')
    expect(req.max_tokens).toBe(64_000)
    // the stable system block carries its own breakpoint; volatile context sits after it
    expect(req.system).toEqual([
      { type: 'text', text: 'STATIC', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'files: index.html' },
    ])
    // automatic breakpoint advances with the growing tool-round history
    expect(req.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('omits effort when unset (provider default) and drops levels the model lacks', () => {
    expect(buildAgentRequest({ ...base, model: 'claude-opus-5-5', effort: null }).output_config).toBeUndefined()
    // 4.6 has no xhigh — never send a level the model 400s on
    expect(buildAgentRequest({ ...base, model: 'claude-sonnet-4-6', effort: 'xhigh' }).output_config).toBeUndefined()
    expect(buildAgentRequest({ ...base, model: 'claude-sonnet-4-6', effort: 'max' }).output_config).toEqual({ effort: 'max' })
  })

  it('legacy models get a plain request: no thinking, effort, betas or fallbacks', () => {
    const req = buildAgentRequest({ ...base, model: 'claude-sonnet-4-5', effort: 'high' })
    expect(req.thinking).toBeUndefined()
    expect(req.output_config).toBeUndefined()
    expect(req.fallbacks).toBeUndefined()
    expect(req.betas).toBeUndefined()
    expect(req.max_tokens).toBeLessThanOrEqual(64_000)
  })
})

describe('AnthropicAgentProvider — the turn loop', () => {
  it('streams thinking + text, runs tools, and replays the assistant content verbatim', async () => {
    const thinkingBlock = { type: 'thinking', thinking: 'Footer goes after main.', signature: 'sig-1' }
    const toolUse = { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'index.html' } }
    const { client, requests } = fakeClient([
      {
        events: [
          { type: 'message_start', message: { usage: usage(100, 0) } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Footer goes after main.' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading the page.' } },
        ],
        final: { content: [thinkingBlock, { type: 'text', text: 'Reading the page.' }, toolUse], stop_reason: 'tool_use', stop_details: null, usage: usage(100, 40, 0, 900) },
      },
      {
        events: [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } }],
        final: { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', stop_details: null, usage: usage(20, 10, 900, 0) },
      },
    ])
    const provider = new AnthropicAgentProvider({ apiKey: 'test', model: 'claude-opus-5-5', client: client as never })
    const c = ctx()
    const items = await collect(provider.runTurn(c))

    expect(items).toContainEqual({ kind: 'thinking', text: 'Footer goes after main.' })
    expect(items).toContainEqual({ kind: 'delta', text: 'Reading the page.' })
    expect(items).toContainEqual({ kind: 'tool_call', name: 'read_file', input: { path: 'index.html' } })
    expect(c.calls).toEqual(['read_file'])
    // usage carries cache accounting per round
    expect(items).toContainEqual({ kind: 'usage', inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 900 })
    expect(items).toContainEqual({ kind: 'usage', inputTokens: 20, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 })
    expect(items.at(-1)).toEqual({ kind: 'message_done', fullText: 'Reading the page.\n\nDone.' })

    // round 2 replays round 1's content UNCHANGED (thinking signature intact) — append-only
    const round2 = requests[1]!.messages as Array<{ role: string; content: unknown }>
    const assistant = round2.find((m) => m.role === 'assistant')!
    expect(assistant.content).toEqual([thinkingBlock, { type: 'text', text: 'Reading the page.' }, toolUse])
    // and round 1's messages are a strict prefix of round 2's (cache + preserved thinking)
    const round1 = requests[0]!.messages as unknown[]
    expect(round2.slice(0, round1.length)).toEqual(round1)
  })

  it('surfaces a refusal with its category instead of ending silently', async () => {
    const { client } = fakeClient([
      {
        events: [],
        final: { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, usage: usage(50, 0) },
      },
    ])
    const provider = new AnthropicAgentProvider({ apiKey: 'test', model: 'claude-opus-5-5', client: client as never })
    const items = await collect(provider.runTurn(ctx()))
    const error = items.find((i) => i.kind === 'error')
    expect(error).toBeDefined()
    expect((error as { message: string }).message).toMatch(/declined.*cyber/i)
  })

  it('never runs tool calls truncated by max_tokens', async () => {
    const { client } = fakeClient([
      {
        events: [],
        final: {
          content: [{ type: 'tool_use', id: 'tu_x', name: 'write_file', input: { path: 'a.html', content: '<ht' } }],
          stop_reason: 'max_tokens',
          stop_details: null,
          usage: usage(10, 64_000),
        },
      },
    ])
    const provider = new AnthropicAgentProvider({ apiKey: 'test', model: 'claude-opus-5-5', client: client as never })
    const c = ctx()
    const items = await collect(provider.runTurn(c))
    expect(c.calls).toEqual([])
    expect(items.some((i) => i.kind === 'error' && /output limit/i.test(i.message))).toBe(true)
  })
})
