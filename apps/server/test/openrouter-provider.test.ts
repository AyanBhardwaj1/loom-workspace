import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamItem, AgentTurnContext } from '@loom/shared'
import { OpenAICompatProvider } from '../src/agent/providers/openrouter'

afterEach(() => vi.unstubAllGlobals())

/** An OpenAI-compatible SSE response body from a list of chunk objects. */
function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(new TextEncoder().encode(body), { status: 200 })
}

function turn(): AgentTurnContext {
  return {
    sessionId: 's1',
    projectName: 'Nimbus',
    moduleName: 'Landing',
    moduleDescription: '',
    driverName: 'Ayan',
    userMessage: 'Add a footer',
    transcript: [],
    fileTree: ['index.html'],
    turnIndex: 0,
    signal: new AbortController().signal,
    executeTool: async () => ({ summary: 'ok', ok: true, content: 'ok' }),
  }
}

describe('OpenAICompatProvider — reasoning + cache accounting', () => {
  it('streams delta.reasoning as thinking and splits cached prompt tokens out of input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { choices: [{ delta: { reasoning: 'Footer after main.' } }] },
          { choices: [{ delta: { content: 'Added it.' } }] },
          { usage: { prompt_tokens: 1_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } },
        ]),
      ),
    )
    const provider = new OpenAICompatProvider({ apiKey: 'k', model: 'anthropic/claude-opus-5.5' })
    const items: AgentStreamItem[] = []
    for await (const item of provider.runTurn(turn())) items.push(item)

    expect(items).toContainEqual({ kind: 'thinking', text: 'Footer after main.' })
    expect(items).toContainEqual({ kind: 'delta', text: 'Added it.' })
    // OpenAI-style prompt_tokens INCLUDES cached tokens — report uncached input separately
    expect(items).toContainEqual({ kind: 'usage', inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 })
  })
})

describe('OpenAICompatProvider — cache writes are not double-billed', () => {
  it('subtracts cache writes from prompt_tokens too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([{ usage: { prompt_tokens: 1_000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 600 } } }])),
    )
    const items: AgentStreamItem[] = []
    for await (const item of new OpenAICompatProvider({ apiKey: 'k', model: 'm' }).runTurn(turn())) items.push(item)
    expect(items).toContainEqual({ kind: 'usage', inputTokens: 100, outputTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 600 })
  })
})
