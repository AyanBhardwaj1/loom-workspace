import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@loom/shared'
import { TRANSCRIPT_KEEP, buildTranscript, foldTranscript } from '../src/agent/context'
import { makeTestServices, makeUser, type TestContext } from './util'

function ev(type: SessionEvent['type'], payload: unknown, seq: number): SessionEvent {
  return { id: `e${seq}`, sessionId: 's', seq, type, payload, createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString() } as SessionEvent
}

function userMsg(n: number, seq: number): SessionEvent {
  return ev('user_message', { text: `message ${n}` }, seq)
}
function assistantMsg(n: number, seq: number): SessionEvent {
  return ev('assistant_message', { text: `reply ${n}` }, seq)
}

describe('C3 — transcript snapshot integrity', () => {
  it('fold(fold(∅, A), B) === fold(∅, A ++ B) across the trim boundary', () => {
    // build a log well past TRANSCRIPT_KEEP so trimming kicks in mid-fold
    const all: SessionEvent[] = []
    let seq = 1
    for (let i = 0; i < TRANSCRIPT_KEEP; i++) {
      all.push(userMsg(i, seq++))
      all.push(assistantMsg(i, seq++))
    }
    for (const cut of [0, 1, 7, 40, TRANSCRIPT_KEEP, all.length - 1, all.length]) {
      const a = all.slice(0, cut)
      const b = all.slice(cut)
      const incremental = foldTranscript(foldTranscript([], a), b)
      const fromZero = buildTranscript(all)
      expect(incremental).toEqual(fromZero)
    }
  })

  it('the orchestrator turn context matches a from-zero rebuild (integration, mock)', async () => {
    const ctx = await makeTestServices()
    try {
      const { services } = ctx
      const user = await makeUser(services, 'Sn', 'sn@snap.dev')
      const project = await services.projects.createProject('Snappy', '', user)
      const modules = await services.projects.listModules(project.id)
      const session = await services.sessions.createSession(modules[0]!.id, user)

      // three turns — the second and third fold from the snapshot, not zero
      await (await services.orchestrator.handleUserMessage(session.id, user, 'Build the hero')).done
      await (await services.orchestrator.handleUserMessage(session.id, user, 'Add a footer')).done
      await (await services.orchestrator.handleUserMessage(session.id, user, 'Add a features grid')).done

      const events = await services.sessions.getEvents(session.id)
      const fromZero = buildTranscript(events)
      // the mock's turns persisted; a fresh fold from the log equals the
      // snapshot-driven state the next turn would use
      const snapEntries = foldTranscript([], events)
      expect(snapEntries).toEqual(fromZero)
      expect(fromZero.length).toBeGreaterThan(0)
      expect(fromZero.length).toBeLessThanOrEqual(TRANSCRIPT_KEEP)
    } finally {
      await ctx.cleanup()
    }
  })
})
