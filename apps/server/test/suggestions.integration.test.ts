import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { ServerMessage } from '@loom/shared'
import { startServer, type RunningServer } from '../src/app'
import { makeTestServices, type TestContext } from './util'

let ctx: TestContext
let server: RunningServer
let base: string

beforeEach(async () => {
  ctx = await makeTestServices()
  server = await startServer(ctx.services, 0)
  base = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  await server.stop()
  await ctx.cleanup()
})

async function signup(name: string, email: string): Promise<{ cookie: string; id: string }> {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password-123' }),
  })
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!
  const body = (await res.json()) as { user: { id: string } }
  return { cookie, id: body.user.id }
}

async function api<T>(cookie: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await res.json()) as T
}

interface Client {
  messages: ServerMessage[]
  send(msg: unknown): void
  waitFor(pred: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>
  close(): void
}

function connect(cookie: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie } })
    const messages: ServerMessage[] = []
    const waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = []
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage
      messages.push(msg)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(msg)) {
          waiters[i]!.resolve(msg)
          waiters.splice(i, 1)
        }
      }
    })
    ws.on('open', () =>
      resolve({
        messages,
        send: (msg) => ws.send(JSON.stringify(msg)),
        waitFor: (pred, ms = 15_000) =>
          new Promise((res, rej) => {
            const found = messages.find(pred)
            if (found) return res(found)
            const timer = setTimeout(() => rej(new Error('waitFor timeout')), ms)
            waiters.push({ pred, resolve: (m) => { clearTimeout(timer); res(m) } })
          }),
        close: () => ws.close(),
      }),
    )
    ws.on('error', reject)
  })
}

const evType = (m: ServerMessage) => (m.t === 'event' ? m.event.type : '')

describe('spectator suggestions (integration)', () => {
  it('propose → driver sees it → accept credits the suggester and runs a turn; single-writer preserved', async () => {
    const ada = await signup('Ada', 'ada@sug.dev')
    const bob = await signup('Bob', 'bob@sug.dev')

    const { project } = await api<{ project: { id: string } }>(ada.cookie, 'POST', '/api/projects', {
      name: 'Suggestly',
    })
    await api(ada.cookie, 'POST', `/api/projects/${project.id}/members`, { email: 'bob@sug.dev' })
    const detail = await api<{ modules: Array<{ id: string }> }>(ada.cookie, 'GET', `/api/projects/${project.id}`)
    const { session } = await api<{ session: { id: string } }>(
      ada.cookie,
      'POST',
      `/api/modules/${detail.modules[0]!.id}/sessions`,
      {},
    )

    const driver = await connect(ada.cookie)
    const spectator = await connect(bob.cookie)
    driver.send({ t: 'sub', sessionId: session.id })
    spectator.send({ t: 'sub', sessionId: session.id })

    // --- Bob (spectator) proposes; both see a persisted suggestion event
    spectator.send({ t: 'suggest', sessionId: session.id, text: 'Add a testimonials section' })
    const sugMsg = await driver.waitFor((m) => m.t === 'event' && m.event.type === 'suggestion')
    if (sugMsg.t !== 'event' || sugMsg.event.type !== 'suggestion') throw new Error('unreachable')
    expect(sugMsg.event.payload.suggesterName).toBe('Bob')
    expect(sugMsg.event.payload.text).toBe('Add a testimonials section')
    const suggestionId = sugMsg.event.payload.suggestionId

    // --- a spectator cannot resolve (single-writer): only the driver can
    spectator.send({ t: 'resolve_suggestion', sessionId: session.id, suggestionId, decision: 'accepted' })
    const err = await spectator.waitFor((m) => m.t === 'error')
    expect(err.t === 'error' && err.message).toMatch(/driver/i)

    // --- driver accepts → decision event + a user_message credited to Bob + a commit
    driver.send({ t: 'resolve_suggestion', sessionId: session.id, suggestionId, decision: 'accepted' })
    const decision = await driver.waitFor(
      (m) => m.t === 'event' && m.event.type === 'suggestion_decision',
    )
    if (decision.t !== 'event' || decision.event.type !== 'suggestion_decision') throw new Error('unreachable')
    expect(decision.event.payload.decision).toBe('accepted')

    const injected = await driver.waitFor(
      (m) => m.t === 'event' && m.event.type === 'user_message' && m.event.payload.suggestedByName === 'Bob',
    )
    if (injected.t !== 'event' || injected.event.type !== 'user_message') throw new Error('unreachable')
    expect(injected.event.payload.text).toBe('Add a testimonials section')
    expect(injected.event.payload.suggestedByUserId).toBe(bob.id)

    await driver.waitFor((m) => m.t === 'event' && m.event.type === 'commit')

    // --- re-resolving the same suggestion is rejected (append-only, decided once)
    driver.send({ t: 'resolve_suggestion', sessionId: session.id, suggestionId, decision: 'dismissed' })
    const already = await driver.waitFor((m) => m.t === 'error' && /already/i.test(m.message))
    expect(already.t).toBe('error')

    driver.close()
    spectator.close()
  })

  it('the driver cannot suggest, and dismiss records a decision without running a turn', async () => {
    const ada = await signup('Ada', 'ada2@sug.dev')
    const bob = await signup('Bob', 'bob2@sug.dev')
    const { project } = await api<{ project: { id: string } }>(ada.cookie, 'POST', '/api/projects', { name: 'S2' })
    await api(ada.cookie, 'POST', `/api/projects/${project.id}/members`, { email: 'bob2@sug.dev' })
    const detail = await api<{ modules: Array<{ id: string }> }>(ada.cookie, 'GET', `/api/projects/${project.id}`)
    const { session } = await api<{ session: { id: string } }>(
      ada.cookie,
      'POST',
      `/api/modules/${detail.modules[0]!.id}/sessions`,
      {},
    )

    const driver = await connect(ada.cookie)
    const spectator = await connect(bob.cookie)
    driver.send({ t: 'sub', sessionId: session.id })
    spectator.send({ t: 'sub', sessionId: session.id })

    // driver cannot suggest to their own session
    driver.send({ t: 'suggest', sessionId: session.id, text: 'nope' })
    const err = await driver.waitFor((m) => m.t === 'error')
    expect(err.t === 'error' && err.message).toMatch(/driving/i)

    // dismiss: decision recorded, no user_message / commit
    spectator.send({ t: 'suggest', sessionId: session.id, text: 'Add a footer' })
    const sug = await driver.waitFor((m) => m.t === 'event' && m.event.type === 'suggestion')
    const suggestionId = sug.t === 'event' && sug.event.type === 'suggestion' ? sug.event.payload.suggestionId : ''
    driver.send({ t: 'resolve_suggestion', sessionId: session.id, suggestionId, decision: 'dismissed' })
    await driver.waitFor((m) => m.t === 'event' && m.event.type === 'suggestion_decision')

    await new Promise((r) => setTimeout(r, 300))
    const persisted = await ctx.services.sessions.getEvents(session.id)
    expect(persisted.some((e) => e.type === 'user_message')).toBe(false)
    expect(persisted.some((e) => e.type === 'commit')).toBe(false)
    const decision = persisted.find((e) => e.type === 'suggestion_decision')
    expect(decision && decision.type === 'suggestion_decision' && decision.payload.decision).toBe('dismissed')

    driver.close()
    spectator.close()
  })
})
