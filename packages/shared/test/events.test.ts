import { describe, expect, it } from 'vitest'
import {
  eventGist,
  parseClientMessage,
  parseServerMessage,
  sessionEventSchema,
  type SessionEvent,
} from '../src/index'

const base = { id: '01ABC', sessionId: 'S1', seq: 1, createdAt: '2026-01-01T00:00:00.000Z' }

describe('sessionEventSchema', () => {
  it('accepts every event type', () => {
    const events: SessionEvent[] = [
      { ...base, type: 'user_message', payload: { text: 'hi' } },
      { ...base, type: 'assistant_delta', payload: { text: 'chunk' }, seq: null },
      { ...base, type: 'assistant_message', payload: { text: 'done' } },
      { ...base, type: 'tool_call', payload: { toolName: 'write_file', input: { path: 'a.txt' } } },
      { ...base, type: 'tool_result', payload: { toolName: 'write_file', summary: 'ok', ok: true } },
      {
        ...base,
        type: 'file_change',
        payload: { path: 'a.txt', changeKind: 'create', unifiedDiff: '+++', additions: 1, deletions: 0 },
      },
      {
        ...base,
        type: 'commit',
        payload: { changeId: 'c1', commitSha: 'abc123', technicalSummary: 't', plainExplanation: 'p' },
      },
      { ...base, type: 'status', payload: { status: 'thinking' } },
      { ...base, type: 'fork_marker', payload: { childSessionId: 's2', byUserName: 'Sai' } },
    ]
    for (const e of events) {
      expect(sessionEventSchema.parse(e)).toEqual(e)
    }
  })

  it('rejects wrong payload shapes', () => {
    expect(sessionEventSchema.safeParse({ ...base, type: 'user_message', payload: {} }).success).toBe(false)
    expect(sessionEventSchema.safeParse({ ...base, type: 'status', payload: { status: 'nope' } }).success).toBe(false)
    expect(sessionEventSchema.safeParse({ ...base, type: 'unknown', payload: {} }).success).toBe(false)
  })

  it('round-trips through JSON', () => {
    const e: SessionEvent = { ...base, type: 'user_message', payload: { text: 'hello world' } }
    expect(sessionEventSchema.parse(JSON.parse(JSON.stringify(e)))).toEqual(e)
  })
})

describe('protocol codecs', () => {
  it('parses valid client messages and rejects junk', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'sub', sessionId: 's1' }))).toEqual({ t: 'sub', sessionId: 's1' })
    expect(
      parseClientMessage(JSON.stringify({ t: 'user_message', sessionId: 's1', text: 'go' })),
    ).toMatchObject({ t: 'user_message' })
    expect(parseClientMessage('not json')).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'user_message', sessionId: 's1', text: '' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'hack' }))).toBeNull()
  })

  it('parses valid server messages', () => {
    const msg = {
      t: 'event',
      sessionId: 's1',
      event: { ...base, type: 'status', payload: { status: 'idle' } },
    }
    expect(parseServerMessage(JSON.stringify(msg))).toMatchObject({ t: 'event' })
    expect(parseServerMessage(JSON.stringify({ t: 'nope' }))).toBeNull()
  })
})

describe('eventGist', () => {
  it('produces short human lines', () => {
    const gist = eventGist({ ...base, type: 'file_change', payload: { path: 'styles.css', changeKind: 'edit', unifiedDiff: '', additions: 1, deletions: 1 } })
    expect(gist).toContain('styles.css')
    expect(gist.length).toBeLessThan(100)
  })
})
