import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { SESSION_COOKIE, signValue } from '../src/auth/cookies'
import { reasoningParam } from '../src/agent/providers/openrouter'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext
let app: FastifyInstance | null = null

beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (app) await app.close()
  app = null
  await ctx.cleanup()
})

async function authedCookies() {
  const user = await makeUser(ctx.services, 'Cat Alog', 'catalog@loom.dev')
  const token = await ctx.services.auth.createAuthSession(user.id)
  return { [SESSION_COOKIE]: signValue(token, ctx.config.cookieSecret) }
}

/** A tiny slice of the real OpenRouter /models response shape. */
const RAW_CATALOG = {
  data: [
    {
      id: 'zz/plain',
      name: 'Plain',
      context_length: 8000,
      pricing: { prompt: '0', completion: '0' },
      reasoning: null,
    },
    {
      id: 'anthropic/claude-opus-5',
      name: 'Claude Opus 5',
      context_length: 1_000_000,
      pricing: { prompt: '0.00001', completion: '0.00005' },
      reasoning: { mandatory: false, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' },
    },
    {
      id: 'deepseek/r1',
      name: 'R1',
      context_length: 64_000,
      pricing: { prompt: '0.0000005', completion: '0.000002' },
      reasoning: { mandatory: true },
    },
    { bogus: 'no id — must be dropped' },
  ],
}

describe('OpenRouter model catalog endpoint', () => {
  it('trims, sorts and normalizes the upstream catalog', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RAW_CATALOG), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    app = await buildApp(ctx.services)
    const cookies = await authedCookies()

    const res = await app.inject({ method: 'GET', url: '/api/settings/openrouter/models', cookies })
    expect(res.statusCode).toBe(200)
    const { models } = res.json() as { models: Array<Record<string, unknown>> }

    expect(models.map((m) => m.id)).toEqual(['anthropic/claude-opus-5', 'deepseek/r1', 'zz/plain'])
    const opus = models[0]!
    expect(opus.promptPrice).toBe(10)
    expect(opus.completionPrice).toBe(50)
    expect(opus.contextLength).toBe(1_000_000)
    // ladder comes back low → max regardless of upstream order
    expect(opus.reasoning).toEqual({ mandatory: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' })
    // toggle-only reasoner: mandatory, no ladder
    expect(models[1]!.reasoning).toEqual({ mandatory: true, efforts: [], defaultEffort: null })
    // non-reasoner stays null; free pricing is 0, not null
    expect(models[2]!.reasoning).toBeNull()
    expect(models[2]!.promptPrice).toBe(0)
  })

  it('caches per process and serves stale on upstream failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(RAW_CATALOG), { status: 200 }))
      .mockRejectedValue(new Error('openrouter down'))
    vi.stubGlobal('fetch', fetchMock)
    app = await buildApp(ctx.services)
    const cookies = await authedCookies()
    const url = '/api/settings/openrouter/models'

    expect((await app.inject({ method: 'GET', url, cookies })).statusCode).toBe(200)
    // within TTL: served from cache, no second upstream call
    expect((await app.inject({ method: 'GET', url, cookies })).statusCode).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // TTL expired + upstream down → the stale copy still answers
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
    const stale = await app.inject({ method: 'GET', url, cookies })
    expect(stale.statusCode).toBe(200)
    expect((stale.json() as { models: unknown[] }).models).toHaveLength(3)
  })

  it('502s with a readable error when there is no cache to fall back to', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    app = await buildApp(ctx.services)
    const cookies = await authedCookies()
    const res = await app.inject({ method: 'GET', url: '/api/settings/openrouter/models', cookies })
    expect(res.statusCode).toBe(502)
    expect((res.json() as { error: string }).error).toMatch(/catalog/i)
  })

  it('requires a signed-in user', async () => {
    app = await buildApp(ctx.services)
    const res = await app.inject({ method: 'GET', url: '/api/settings/openrouter/models' })
    expect(res.statusCode).toBe(401)
  })
})

describe('reasoning setting → runtime → request param', () => {
  it('persists reasoning through configure, describe and reboot', async () => {
    // validation ping goes through fetch — always succeed
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    app = await buildApp(ctx.services)
    const cookies = await authedCookies()

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/ai',
      cookies,
      payload: { provider: 'openrouter', apiKey: 'sk-or-test-12345678', model: 'anthropic/claude-opus-5', reasoning: 'max' },
    })
    expect(put.statusCode).toBe(200)
    expect((put.json() as { reasoning: string | null }).reasoning).toBe('max')

    const get = await app.inject({ method: 'GET', url: '/api/settings/ai', cookies })
    expect((get.json() as { reasoning: string | null }).reasoning).toBe('max')

    // simulated reboot: re-hydrate from app_settings
    ctx.services.runtime.reasoning = null
    await ctx.services.runtime.loadPersisted()
    expect(ctx.services.runtime.reasoning).toBe('max')
    expect(ctx.services.runtime.describe().reasoning).toBe('max')

    // clearing the key clears the reasoning setting with it
    const del = await app.inject({ method: 'DELETE', url: '/api/settings/ai', cookies })
    expect((del.json() as { reasoning: string | null }).reasoning).toBeNull()
  })

  it('rejects reasoning values outside the ladder', async () => {
    app = await buildApp(ctx.services)
    const cookies = await authedCookies()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/ai',
      cookies,
      payload: { provider: 'openrouter', apiKey: 'sk-or-test-12345678', reasoning: 'ultra' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('maps settings onto the unified OpenRouter reasoning param', () => {
    expect(reasoningParam(null)).toEqual({})
    expect(reasoningParam(undefined)).toEqual({})
    expect(reasoningParam('low')).toEqual({ reasoning: { effort: 'low' } })
    expect(reasoningParam('max')).toEqual({ reasoning: { effort: 'max' } })
    expect(reasoningParam('on')).toEqual({ reasoning: { enabled: true } })
    expect(reasoningParam('off')).toEqual({ reasoning: { enabled: false } })
  })
})
