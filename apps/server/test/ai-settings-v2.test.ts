import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { SESSION_COOKIE, signValue } from '../src/auth/cookies'
import { CLAUDE_MODELS } from '../src/agent/claudeModels'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext
let app: FastifyInstance

beforeEach(async () => {
  ctx = await makeTestServices()
  app = await buildApp(ctx.services)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  await ctx.cleanup()
})

async function cookies() {
  const user = await makeUser(ctx.services, 'Set Tings', 'settings@loom.dev')
  const token = await ctx.services.auth.createAuthSession(user.id)
  return { [SESSION_COOKIE]: signValue(token, ctx.config.cookieSecret) }
}

describe('GET /api/settings/anthropic/models', () => {
  it('serves the curated Claude catalog with per-model effort ladders', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/anthropic/models', cookies: await cookies() })
    expect(res.statusCode).toBe(200)
    const { models } = res.json() as { models: typeof CLAUDE_MODELS }
    expect(models.map((m) => m.id)).toEqual(CLAUDE_MODELS.map((m) => m.id))
    expect(models[0]!.efforts).toContain('max')
  })

  it('requires a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/anthropic/models' })
    expect(res.statusCode).toBe(401)
  })
})

describe('PUT /api/settings/ai — change model/effort without re-pasting the key', () => {
  it('reuses the stored key when the provider is unchanged', async () => {
    // OpenRouter validation goes through fetch — always succeed, and record the auth header
    const auths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        auths.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))
        return new Response('{}', { status: 200 })
      }),
    )
    const c = await cookies()
    const first = await app.inject({
      method: 'PUT',
      url: '/api/settings/ai',
      cookies: c,
      payload: { provider: 'openrouter', apiKey: 'sk-or-original-12345678', model: 'anthropic/claude-opus-5.5' },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'PUT',
      url: '/api/settings/ai',
      cookies: c,
      payload: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', reasoning: 'high' },
    })
    expect(second.statusCode).toBe(200)
    const body = second.json() as { model: string; reasoning: string; maskedKey: string }
    expect(body.model).toBe('anthropic/claude-sonnet-5.5')
    expect(body.reasoning).toBe('high')
    expect(body.maskedKey).toBe('sk-…5678')
    // the second validation used the stored key — it never left the server otherwise
    expect(auths.at(-1)).toBe('Bearer sk-or-original-12345678')
  })

  it('never sends a stored key to a different endpoint (exfiltration guard)', async () => {
    const calls: Array<{ url: string; auth: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? '') })
        return new Response('{}', { status: 200 })
      }),
    )
    const c = await cookies()
    await app.inject({
      method: 'PUT',
      url: '/api/settings/ai',
      cookies: c,
      payload: { provider: 'openrouter', apiKey: 'sk-or-secret-12345678', baseUrl: 'https://llm.internal.example/v1' },
    })
    calls.length = 0

    // keyless change pointing somewhere else → refused before any request is made
    const evil = await app.inject({
      method: 'PUT',
      url: '/api/settings/ai',
      cookies: c,
      payload: { provider: 'openrouter', baseUrl: 'https://attacker.example/v1' },
    })
    expect(evil.statusCode).toBe(400)
    expect(calls).toEqual([])

    // keyless change that omits baseUrl keeps the STORED endpoint (not openrouter.ai)
    const keep = await app.inject({ method: 'PUT', url: '/api/settings/ai', cookies: c, payload: { provider: 'openrouter', model: 'x/y' } })
    expect(keep.statusCode).toBe(200)
    expect(calls.every((call) => call.url.startsWith('https://llm.internal.example/v1'))).toBe(true)
    expect((keep.json() as { baseUrl: string }).baseUrl).toBe('https://llm.internal.example/v1')
  })

  it('still requires a key when switching providers or when none is stored', async () => {
    const c = await cookies()
    const none = await app.inject({ method: 'PUT', url: '/api/settings/ai', cookies: c, payload: { provider: 'anthropic', model: 'claude-opus-5-5' } })
    expect(none.statusCode).toBe(400)
    expect((none.json() as { error: string }).error).toMatch(/API key/i)
  })
})
