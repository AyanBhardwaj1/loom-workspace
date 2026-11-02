import { describe, expect, it } from 'vitest'
import { deriveSessionState, type SessionEvent } from '@loom/shared'

let seq = 0
const ev = (type: SessionEvent['type'], payload: unknown, createdAt = '2026-10-25T12:00:00.000Z'): SessionEvent =>
  ({ id: String(++seq), sessionId: 's', seq, createdAt, type, payload }) as SessionEvent
const NOW = Date.parse('2026-10-25T12:05:00.000Z')

describe('deriveSessionState — one answer for every viewer, from the log alone', () => {
  it('working: names what the agent is doing right now', () => {
    const events = [
      ev('user_message', { text: 'go' }),
      ev('status', { status: 'running_tools' }),
      ev('tool_call', { toolName: 'edit_file', input: { path: 'index.html' } }),
    ]
    expect(deriveSessionState({ events, now: NOW })).toEqual({ state: 'working', detail: 'editing index.html' })
    expect(deriveSessionState({ events: events.slice(0, 2), now: NOW }).detail).toBe('thinking')
  })

  it('needs-testing until every proposed case has a verdict', () => {
    const base = [
      ev('user_message', { text: 'form' }),
      ev('test_plan', { planId: 'p', cases: [{ id: 't1', action: 'a', expect: 'b' }, { id: 't2', action: 'c', expect: 'd' }] }),
      ev('status', { status: 'idle' }),
    ]
    expect(deriveSessionState({ events: base, now: NOW })).toEqual({ state: 'needs-testing', detail: '2 tests to try' })
    const one = [...base, ev('test_verdict', { planId: 'p', caseId: 't1', verdict: 'fail', byUserId: 'u', byName: 'Sai' })]
    expect(deriveSessionState({ events: one, now: NOW }).detail).toBe('1 test to try')
    const all = [...one, ev('test_verdict', { planId: 'p', caseId: 't2', verdict: 'pass', byUserId: 'u', byName: 'Sai' })]
    expect(deriveSessionState({ events: all, now: NOW }).state).toBe('idle')
  })

  it('your-move when the agent ended its turn on a question; stale when quiet; error and ended win', () => {
    const asked = [ev('user_message', { text: 'x' }), ev('assistant_message', { text: 'Which colour should the button be?' }), ev('status', { status: 'idle' })]
    expect(deriveSessionState({ events: asked, driverName: 'Ayan', now: NOW })).toEqual({ state: 'your-move', detail: 'asked Ayan a question' })
    const quiet = [ev('user_message', { text: 'x' }), ev('status', { status: 'idle' }, '2026-10-25T10:00:00.000Z')]
    expect(deriveSessionState({ events: quiet, now: NOW }).state).toBe('stale')
    expect(deriveSessionState({ events: [ev('status', { status: 'error', note: 'boom' })], now: NOW })).toEqual({ state: 'error', detail: 'boom' })
    expect(deriveSessionState({ events: asked, ended: true, now: NOW }).state).toBe('ended')
    expect(deriveSessionState({ events: asked, checking: true, now: NOW }).state).toBe('checking')
  })
})
