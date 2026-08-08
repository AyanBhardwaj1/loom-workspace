import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/agent/runtime'
import { makeTestServices, makeUser, type TestContext } from './util'

/**
 * A tiny in-process "OpenRouter": speaks the OpenAI chat-completions protocol
 * (auth, SSE streaming, tool calls) so the ENTIRE runtime-key feature — paste
 * key → validate → persist → hot-swap → real streamed turn with tool use →
 * commit with model-written summary — is proven without any real API key.
 */
let fakeLlm: http.Server
let fakeLlmUrl = ''
let streamedCalls = 0

function sse(res: http.ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const p of payloads) res.write(`data: ${JSON.stringify(p)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

beforeAll(async () => {
  fakeLlm = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += String(c)))
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer sk-or-goodkey') {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      }
      const parsed = JSON.parse(body) as { stream?: boolean; max_tokens?: number }
      if (!parsed.stream) {
        // validation ping (max_tokens 1) or summarizer call — plain JSON
        const content =
          parsed.max_tokens === 1
            ? 'ok'
            : 'TECHNICAL: Add greeting file from fake LLM\nPLAIN: The agent wrote a friendly hello file.'
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      }
      streamedCalls++
      if (streamedCalls === 1) {
        // round 1: stream some narration, then a tool call, split across deltas
        return sse(res, [
          { choices: [{ delta: { content: 'Writing the ' } }] },
          { choices: [{ delta: { content: 'hello file now.' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"path":"from-' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'llm.txt","content":"hello from the fake llm"}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])
      }
      // round 2: plain completion, no tools
      return sse(res, [
        { choices: [{ delta: { content: 'Done — the file is in place.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])
    })
  })
  await new Promise<void>((resolve) => fakeLlm.listen(0, '127.0.0.1', resolve))
  const addr = fakeLlm.address()
  fakeLlmUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`
})

afterAll(() => {
  fakeLlm.close()
})

let ctx: TestContext

beforeEach(async () => {
  ctx = await makeTestServices()
  streamedCalls = 0
})

afterEach(async () => {
  await ctx.cleanup()
})

describe('runtime AI provider (integration, fake OpenAI-compatible server)', () => {
  it('rejects a bad key with a human-readable error and stays on mock', async () => {
    const { services } = ctx
    const res = await services.runtime.configure({
      provider: 'openrouter',
      apiKey: 'sk-or-badkey',
      model: 'fake-model',
      baseUrl: fakeLlmUrl,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/rejected/i)
    expect(services.runtime.mode).toBe('mock')
  })

  it('accepts a valid key, persists it, hot-swaps, and drives a REAL streamed turn with tool use', async () => {
    const { services, config } = ctx
    expect(services.runtime.mode).toBe('mock')

    // paste the key (as the settings route would)
    const res = await services.runtime.configure({
      provider: 'openrouter',
      apiKey: 'sk-or-goodkey',
      model: 'fake-model',
      baseUrl: fakeLlmUrl,
    })
    expect(res.ok).toBe(true)
    const described = services.runtime.describe()
    expect(described.mode).toBe('openrouter')
    expect(described.model).toBe('fake-model')
    expect(described.source).toBe('runtime')
    expect(described.maskedKey).not.toContain('goodkey') // never echo the key
    expect(described.maskedKey).toMatch(/…/)

    // persisted: a fresh runtime (server restart) restores it
    const rebooted = new AgentRuntime(config, services.dbh, { fastMock: true })
    expect(rebooted.mode).toBe('mock')
    await rebooted.loadPersisted()
    expect(rebooted.mode).toBe('openrouter')
    expect(rebooted.model).toBe('fake-model')

    // the ALREADY-CONSTRUCTED orchestrator now talks to the fake LLM — no restart
    const user = await makeUser(services, 'Ada', 'ada@runtime.dev')
    const project = await services.projects.createProject('Realish', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)
    const turn = await services.orchestrator.handleUserMessage(session.id, user, 'Write a hello file')
    expect(turn.ok).toBe(true)
    await turn.done

    const events = await services.sessions.getEvents(session.id)
    const types = events.map((e) => e.type)
    expect(types).toContain('tool_call')
    expect(types).toContain('file_change')
    expect(types).toContain('commit')
    const assistant = events.find((e) => e.type === 'assistant_message')!
    expect(assistant.type === 'assistant_message' && assistant.payload.text).toContain('Done — the file is in place.')

    // the model's tool call really executed in the sandboxed worktree
    const filePath = path.join(session.worktreePath, 'from-llm.txt')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello from the fake llm')

    // and the commit summary came from the model, not the template
    const changes = await services.projects.listChanges(project.id)
    expect(changes[0]!.technicalSummary).toBe('Add greeting file from fake LLM')
    expect(changes[0]!.plainExplanation).toContain('friendly hello file')

    // clear() falls back to mock
    const cleared = await services.runtime.clear()
    expect(cleared.mode).toBe('mock')
    expect(services.runtime.mode).toBe('mock')
  })

  it('the settings routes gate on auth and never leak the key', async () => {
    const { services } = ctx
    const { startServer } = await import('../src/app')
    const server = await startServer(services, 0)
    const base = `http://127.0.0.1:${server.port}`
    try {
      const anon = await fetch(`${base}/api/settings/ai`)
      expect(anon.status).toBe(401)

      const signup = await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', email: 'ada@settings.dev', password: 'password-123' }),
      })
      const cookie = signup.headers.get('set-cookie')!.split(';')[0]!

      const put = await fetch(`${base}/api/settings/ai`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          provider: 'openrouter',
          apiKey: 'sk-or-goodkey',
          model: 'fake-model',
          baseUrl: fakeLlmUrl,
        }),
      })
      expect(put.status).toBe(200)
      const putBody = (await put.json()) as { maskedKey: string; mode: string }
      expect(putBody.mode).toBe('openrouter')
      expect(JSON.stringify(putBody)).not.toContain('sk-or-goodkey')

      const get = await fetch(`${base}/api/settings/ai`, { headers: { cookie } })
      expect(JSON.stringify(await get.json())).not.toContain('sk-or-goodkey')

      const del = await fetch(`${base}/api/settings/ai`, { method: 'DELETE', headers: { cookie } })
      expect(((await del.json()) as { mode: string }).mode).toBe('mock')
    } finally {
      await server.stop()
    }
  })
})
