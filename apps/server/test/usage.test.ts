import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sumUsage } from '@loom/shared'
import { estimateCostUsd } from '../src/agent/pricing'
import { makeTestServices, makeUser, type TestContext } from './util'

describe('pricing.estimateCostUsd', () => {
  it('is free for the mock, and priced per-model for real providers', () => {
    expect(estimateCostUsd('mock', null, 10_000, 5_000)).toBe(0)
    // sonnet: $3/M in, $15/M out → 1M in + 1M out = $18
    expect(estimateCostUsd('anthropic', 'claude-sonnet-4-5', 1_000_000, 1_000_000)).toBeCloseTo(18, 5)
    // haiku is cheaper than sonnet for the same tokens
    const haiku = estimateCostUsd('anthropic', 'claude-3-5-haiku-latest', 1_000_000, 1_000_000)
    const sonnet = estimateCostUsd('anthropic', 'claude-sonnet-4-5', 1_000_000, 1_000_000)
    const opus = estimateCostUsd('anthropic', 'claude-opus-4', 1_000_000, 1_000_000)
    expect(haiku).toBeLessThan(sonnet)
    expect(sonnet).toBeLessThan(opus)
    // unknown model falls back to a default, still > 0
    expect(estimateCostUsd('openrouter', 'some/unknown-model', 1_000_000, 0)).toBeGreaterThan(0)
  })
})

let ctx: TestContext

beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

describe('usage tracking (integration, mock)', () => {
  it('records a usage event per turn and sums per session', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Ada', 'ada@usage.dev')
    const project = await services.projects.createProject('Metered', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    await (await services.orchestrator.handleUserMessage(session.id, user, 'Build the hero section')).done
    await (await services.orchestrator.handleUserMessage(session.id, user, 'Now add a footer')).done

    const events = await services.sessions.getEvents(session.id)
    const usageEvents = events.filter((e) => e.type === 'usage')
    expect(usageEvents.length).toBe(2) // one per turn
    for (const e of usageEvents) {
      if (e.type !== 'usage') throw new Error('unreachable')
      expect(e.payload.inputTokens).toBeGreaterThan(0)
      expect(e.payload.outputTokens).toBeGreaterThan(0)
      expect(e.payload.provider).toBe('mock')
      expect(e.payload.costUsd).toBe(0) // mock is free
    }

    // usage events are not chat rows and carry a real seq (persisted)
    expect(usageEvents.every((e) => e.seq !== null)).toBe(true)

    // sumUsage (shared) matches the per-session server aggregation
    const summed = sumUsage(events)
    expect(summed.turns).toBe(2)
    expect(summed.inputTokens).toBeGreaterThan(0)

    const totals = await services.sessions.usageTotalsForSessions([session.id])
    const total = totals.get(session.id)!
    expect(total.tokens).toBe(summed.inputTokens + summed.outputTokens)
    expect(total.costUsd).toBe(summed.costUsd)
  })
})
