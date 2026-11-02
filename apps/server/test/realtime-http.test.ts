import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '@loom/shared'
import { buildApp } from '../src/app'
import { SESSION_COOKIE, signValue } from '../src/auth/cookies'
import { sessionTopic } from '../src/realtime/bus'
import { makeTestServices, makeUser, type TestContext } from './util'

/** The serverless transport: outbox bus + long-poll + HTTP send, end to end. */
let ctx: TestContext
beforeEach(async () => {
  ctx = await makeTestServices({ platform: 'serverless' })
})
afterEach(async () => {
  await ctx.cleanup()
})

async function world() {
  const { services } = ctx
  const ayan = await makeUser(services, 'Ayan', 'ayan@rt.dev')
  const sai = await makeUser(services, 'Sai', 'sai@rt.dev')
  const eve = await makeUser(services, 'Eve', 'eve@rt.dev')
  const project = await services.projects.createProject('Polled', '', ayan)
  await services.projects.addMemberByEmail(project.id, 'sai@rt.dev')
  const [mod] = await services.projects.listModules(project.id)
  const session = await services.sessions.createSession(mod!.id, ayan)
  const app = await buildApp(services)
  const cookie = async (id: string) => ({ [SESSION_COOKIE]: signValue(await services.auth.createAuthSession(id), ctx.config.cookieSecret) })
  const poll = async (userId: string, clientId: string, body: Record<string, unknown>) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/rt/poll',
        cookies: await cookie(userId),
        payload: { clientId, sessions: [], projects: [], viewing: null, reading: null, waitMs: 0, ...body },
      })
    ).json() as { cursor: number; messages: ServerMessage[] }
  const send = async (userId: string, clientId: string, messages: unknown[]) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/rt/send',
        cookies: await cookie(userId),
        payload: { clientId, messages: messages.map((m) => JSON.stringify(m)) },
      })
    ).json() as { replies: ServerMessage[] }
  return { services, ayan, sai, eve, project, session, app, poll, send }
}

describe('realtime over HTTP (serverless)', () => {
  it('a teammate’s message reaches a poller on the next poll, identity stamped by the server', async () => {
    const w = await world()
    try {
      const first = await w.poll(w.ayan.id, 'ayan-tab-1', { cursor: null, sessions: [w.session.id], projects: [w.project.id] })
      const res = await w.send(w.sai.id, 'sai-tab-1', [
        { t: 'preview_presence', sessionId: w.session.id, kind: 'click', x: 10, y: 20, path: '/', label: 'button · Go' },
        { t: 'suggest', sessionId: w.session.id, text: 'Add a footer' },
      ])
      expect(res.replies.filter((r) => r.t === 'error')).toEqual([])
      const next = await w.poll(w.ayan.id, 'ayan-tab-1', { cursor: first.cursor, sessions: [w.session.id], projects: [w.project.id] })
      expect(next.messages.find((m) => m.t === 'preview_presence')).toMatchObject({ userId: w.sai.id, name: 'Sai', label: 'button · Go' })
      const ev = next.messages.find((m) => m.t === 'event' && m.event.type === 'suggestion')
      expect(ev).toBeTruthy()
      expect(next.cursor).toBeGreaterThan(first.cursor)
      // presence: both tabs that declared the project are listed
      await w.poll(w.sai.id, 'sai-tab-1', { cursor: null, projects: [w.project.id], viewing: w.session.id })
      const again = await w.poll(w.ayan.id, 'ayan-tab-1', { cursor: next.cursor, projects: [w.project.id] })
      const presence = again.messages.find((m) => m.t === 'presence')
      expect(presence && presence.t === 'presence' ? presence.users.map((u) => u.name).sort() : []).toEqual(['Ayan', 'Sai'])
      expect(presence && presence.t === 'presence' ? presence.users.find((u) => u.name === 'Sai')?.viewing : null).toBe(w.session.id)
    } finally {
      await w.app.close()
    }
  })

  it('non-members hear nothing and cannot act; catch-up replies come back in the response', async () => {
    const w = await world()
    try {
      const eveFirst = await w.poll(w.eve.id, 'eve-tab-1', { cursor: null, sessions: [w.session.id], projects: [w.project.id] })
      await w.send(w.sai.id, 'sai-tab-2', [{ t: 'suggest', sessionId: w.session.id, text: 'secret plan' }])
      const eveNext = await w.poll(w.eve.id, 'eve-tab-1', { cursor: eveFirst.cursor, sessions: [w.session.id], projects: [w.project.id] })
      expect(eveNext.messages).toEqual([])
      const denied = await w.send(w.eve.id, 'eve-tab-1', [{ t: 'suggest', sessionId: w.session.id, text: 'let me in' }])
      expect(denied.replies[0]).toMatchObject({ t: 'error', code: 'forbidden' })
      const catchup = await w.send(w.ayan.id, 'ayan-tab-2', [{ t: 'catchup', sessionId: w.session.id, afterSeq: 0 }])
      const batch = catchup.replies.find((r) => r.t === 'catchup_batch')
      expect(batch && batch.t === 'catchup_batch' ? batch.events.some((e) => e.type === 'suggestion') : false).toBe(true)
    } finally {
      await w.app.close()
    }
  })

  it('token streams are coalesced into a few outbox rows, in order, with nothing lost', async () => {
    const w = await world()
    try {
      const first = await w.poll(w.ayan.id, 'stream-tab', { cursor: null, sessions: [w.session.id] })
      for (let i = 0; i < 60; i++) {
        w.services.sessions.publishTransient(w.session.id, 'assistant_delta', { text: `t${i} ` })
      }
      w.services.bus.publish(sessionTopic(w.session.id), { t: 'reaction', sessionId: w.session.id, emoji: '🎉', atSeq: null, byName: 'x', byColor: '#000' })
      await w.services.bus.flush?.()
      const got = await w.poll(w.ayan.id, 'stream-tab', { cursor: first.cursor, sessions: [w.session.id] })
      const deltas = got.messages.filter((m) => m.t === 'event' && m.event.type === 'assistant_delta')
      expect(deltas.length).toBeLessThanOrEqual(3)
      const text = deltas.map((m) => (m.t === 'event' && m.event.type === 'assistant_delta' ? m.event.payload.text : '')).join('')
      expect(text).toBe(Array.from({ length: 60 }, (_, i) => `t${i} `).join(''))
      // the stream was flushed before the reaction that followed it
      expect(got.messages[got.messages.length - 1]).toMatchObject({ t: 'reaction' })
    } finally {
      await w.app.close()
    }
  })

  it('a stop request reaches a turn running on another instance (coordination via the DB)', async () => {
    const w = await world()
    try {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      w.services.runtime.provider = {
        async *runTurn(turn) {
          yield { kind: 'tool_call', name: 'list_files', input: {} }
          await turn.executeTool('list_files', {})
          await Promise.race([gate, new Promise((r) => turn.signal.addEventListener('abort', r))])
          yield { kind: 'message_done', fullText: turn.signal.aborted ? 'stopped' : 'done' }
        },
      }
      const started = await w.services.orchestrator.handleUserMessage(w.session.id, w.ayan, 'go')
      expect(started.ok).toBe(true)
      // simulate "another instance": no local aborter, only the shared lease is visible
      expect(await w.services.coord.get(`turn:${w.session.id}`)).not.toBeNull()
      await w.services.coord.set(`stop:${w.session.id}`, '1', 60_000)
      if (started.ok) await started.done
      release()
      const events = await w.services.sessions.getEvents(w.session.id, 0)
      const last = [...events].reverse().find((e) => e.type === 'status')
      expect(last?.payload).toMatchObject({ status: 'idle', note: 'Stopped by driver' })
      expect(await w.services.orchestrator.isBusy(w.session.id)).toBe(false)
    } finally {
      await w.app.close()
    }
  })
})
