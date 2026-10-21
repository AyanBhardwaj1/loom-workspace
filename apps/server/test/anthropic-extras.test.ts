import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamItem, AgentTurnContext } from '@loom/shared'
import { AnthropicAgentProvider, AnthropicSummarizer, makeAnthropicConflictResolver } from '../src/agent/providers/anthropic'
import { loadConfig } from '../src/env'
import { makeTestServices } from './util'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Call = { url: string; body: Record<string, unknown> | null }

/** Route the real SDK's HTTP through a stub; records every request. */
function stubFetch(handler: (url: string, body: Record<string, unknown> | null) => Response): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      calls.push({ url, body })
      return handler(url, body)
    }),
  )
  return calls
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })

const message = (text: string, stop_reason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text }],
  stop_reason,
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 10 },
})

/** An SSE body for one streamed message with a single text block. */
function sseMessage(text: string, stop_reason = 'end_turn'): Response {
  const events = [
    ['message_start', { type: 'message_start', message: { ...message(''), content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason, stop_details: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const summaryInput = {
  projectName: 'Nimbus',
  moduleName: 'Landing',
  driverName: 'Ayan',
  userMessage: 'Add a footer',
  diffs: [{ path: 'index.html', changeKind: 'edit' as const, additions: 3, deletions: 0, unifiedDiff: '+<footer></footer>' }],
}

describe('AnthropicSummarizer', () => {
  it('parses the two-line reply and asks current models for low effort', async () => {
    const calls = stubFetch(() => json(200, message('TECHNICAL: Add site footer\nPLAIN: The page now ends with a footer.')))
    const out = await new AnthropicSummarizer({ apiKey: 'k', model: 'claude-haiku-5-5' }).summarize(summaryInput)
    expect(out).toEqual({ technicalSummary: 'Add site footer', plainExplanation: 'The page now ends with a footer.' })
    expect(calls[0]!.body!.output_config).toEqual({ effort: 'low' })
    // thinking counts toward max_tokens on current models — not the old 400
    expect(calls[0]!.body!.max_tokens).toBeGreaterThanOrEqual(2000)
  })

  it('falls back to the template — loudly — when the model is gone', async () => {
    stubFetch(() => json(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-3-5-haiku-latest' } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await new AnthropicSummarizer({ apiKey: 'k', model: 'claude-3-5-haiku-latest' }).summarize(summaryInput)
    expect(out.technicalSummary.length).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalled()
  })

  it('falls back when the reply does not follow the format', async () => {
    stubFetch(() => json(200, message('Sure! I added a footer.')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await new AnthropicSummarizer({ apiKey: 'k', model: 'claude-haiku-5-5' }).summarize(summaryInput)
    expect(out.technicalSummary).not.toBe('Sure! I added a footer.')
  })
})

describe('Anthropic conflict resolver', () => {
  const config = () => ({ ...loadConfig(), anthropicApiKey: 'k', anthropicModel: 'claude-opus-5-5' })

  it('returns the merged file, stripping a stray code fence', async () => {
    stubFetch(() => sseMessage('```html\n<p>both</p>\n```'))
    const resolve = makeAnthropicConflictResolver(config())
    expect(await resolve('a.html', '<<<<<<< ours\n<p>a</p>\n=======\n<p>b</p>\n>>>>>>> theirs')).toBe('<p>both</p>')
  })

  it('refuses output that still has markers or was truncated', async () => {
    stubFetch(() => sseMessage('<<<<<<< still conflicted'))
    expect(await makeAnthropicConflictResolver(config())('a.html', 'x')).toBeNull()
    stubFetch(() => sseMessage('<p>half a fi', 'max_tokens'))
    expect(await makeAnthropicConflictResolver(config())('a.html', 'x')).toBeNull()
  })
})

describe('provider errors are actionable for the driver', () => {
  const turn = (): AgentTurnContext => ({
    sessionId: 's',
    projectName: 'P',
    moduleName: 'M',
    moduleDescription: '',
    driverName: 'Ayan',
    userMessage: 'hi',
    transcript: [],
    fileTree: [],
    turnIndex: 0,
    signal: new AbortController().signal,
    executeTool: async () => ({ summary: 'ok', ok: true }),
  })

  it.each([
    [401, 'authentication_error', /API key/],
    [404, 'not_found_error', /recognize this model/],
    [429, 'rate_limit_error', /rate-limiting/],
  ])('HTTP %i → a plain-language error', async (status, type, pattern) => {
    stubFetch(() => json(status, { type: 'error', error: { type, message: 'nope' } }))
    // no retries in the test: a 429 would otherwise back off
    const provider = new AnthropicAgentProvider({ apiKey: 'sk-ant-secret', model: 'claude-opus-5-5' })
    ;(provider as unknown as { client: { maxRetries: number } }).client.maxRetries = 0
    const items: AgentStreamItem[] = []
    for await (const item of provider.runTurn(turn())) items.push(item)
    const error = items.find((i) => i.kind === 'error') as { message: string } | undefined
    expect(error?.message).toMatch(pattern)
    expect(error?.message).not.toContain('sk-ant-secret')
  })
})

describe('runtime key validation (Models API — free)', () => {
  it.each([
    [200, { id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }, null],
    [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, /rejected that API key/],
    [404, { type: 'error', error: { type: 'not_found_error', message: 'model not found' } }, /doesn't recognize the model/],
  ])('Models API %i', async (status, payload, errorPattern) => {
    const calls = stubFetch(() => json(status, payload))
    const ctx = await makeTestServices()
    try {
      const res = await ctx.services.runtime.configure({ provider: 'anthropic', apiKey: 'sk-ant-test-12345678', model: 'claude-opus-5-5' })
      // validation is a model lookup, never a billed generation
      expect(calls.every((c) => c.url.includes('/v1/models/'))).toBe(true)
      if (errorPattern) {
        expect(res.ok).toBe(false)
        expect(!res.ok && res.error).toMatch(errorPattern)
      } else {
        expect(res.ok).toBe(true)
      }
    } finally {
      await ctx.cleanup()
    }
  })
})
