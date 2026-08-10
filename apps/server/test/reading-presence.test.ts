import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClientMessage } from '@loom/shared'
import { makeTestServices, type TestContext } from './util'

let ctx: TestContext

beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

describe('1.2 — transient reaction protocol', () => {
  it('parses react/reaction frames and rejects malformed ones', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'react', sessionId: 's1', emoji: '🔥', atSeq: 12 }))).toEqual({
      t: 'react',
      sessionId: 's1',
      emoji: '🔥',
      atSeq: 12,
    })
    expect(parseClientMessage(JSON.stringify({ t: 'react', sessionId: 's1', emoji: '🎉', atSeq: null }))).toEqual({
      t: 'react',
      sessionId: 's1',
      emoji: '🎉',
      atSeq: null,
    })
    // missing atSeq → rejected; emoji too long → rejected
    expect(parseClientMessage(JSON.stringify({ t: 'react', sessionId: 's1', emoji: '🔥' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'react', sessionId: 's1', emoji: 'x'.repeat(20), atSeq: 1 }))).toBeNull()
  })

  it('reactions are never a persisted event type', async () => {
    const { PERSISTED_EVENT_TYPES } = await import('@loom/shared')
    expect(PERSISTED_EVENT_TYPES).not.toContain('reaction')
    expect(PERSISTED_EVENT_TYPES).not.toContain('react')
  })
})

describe('F5 — read-position presence protocol', () => {
  it('accepts the reading message and keeps it ephemeral (schema-level)', () => {
    const ok = parseClientMessage(JSON.stringify({ t: 'reading', sessionId: 's1', eventId: 'e9' }))
    expect(ok).toEqual({ t: 'reading', sessionId: 's1', eventId: 'e9' })
    const cleared = parseClientMessage(JSON.stringify({ t: 'reading', sessionId: 's1', eventId: null }))
    expect(cleared).toEqual({ t: 'reading', sessionId: 's1', eventId: null })
    // malformed → rejected, never throws
    expect(parseClientMessage(JSON.stringify({ t: 'reading', sessionId: 's1' }))).toBeNull()
  })

  it('never persists a reading event to the session log', async () => {
    const { services } = ctx
    // the event-log schema has no 'reading' type — this is a compile-time
    // guarantee; assert the persisted-type list at runtime for regression
    const { PERSISTED_EVENT_TYPES } = await import('@loom/shared')
    expect(PERSISTED_EVENT_TYPES).not.toContain('reading')
    expect(services).toBeTruthy()
  })
})
