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

async function signupViaHttp(name: string, email: string): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password-123' }),
  })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie')!
  const cookie = setCookie.split(';')[0]!
  const body = (await res.json()) as { user: { id: string } }
  return { cookie, userId: body.user.id }
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
  ws: WebSocket
  messages: ServerMessage[]
  send(msg: unknown): void
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>
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
        ws,
        messages,
        send: (msg) => ws.send(JSON.stringify(msg)),
        waitFor: (pred, timeoutMs = 15_000) =>
          new Promise((res, rej) => {
            const existing = messages.find(pred)
            if (existing) return res(existing)
            const timer = setTimeout(() => rej(new Error('waitFor timeout')), timeoutMs)
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(timer)
                res(m)
              },
            })
          }),
        close: () => ws.close(),
      }),
    )
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected: ${res.statusCode}`)))
    ws.on('error', reject)
  })
}

describe('realtime (integration)', () => {
  it('rejects unauthenticated upgrades', async () => {
    await expect(connect('loom_session=forged')).rejects.toThrow(/401/)
  })

  it('driver streams, spectator watches live, catchup replays, non-driver is rejected', async () => {
    const ada = await signupViaHttp('Ada', 'ada@rt.dev')
    const bob = await signupViaHttp('Bob', 'bob@rt.dev')

    const { project } = await api<{ project: { id: string } }>(ada.cookie, 'POST', '/api/projects', {
      name: 'RTly',
      description: 'realtime test',
    })
    await api(ada.cookie, 'POST', `/api/projects/${project.id}/members`, { email: 'bob@rt.dev' })
    const detail = await api<{ modules: Array<{ id: string }> }>(ada.cookie, 'GET', `/api/projects/${project.id}`)
    const { session } = await api<{ session: { id: string } }>(
      ada.cookie,
      'POST',
      `/api/modules/${detail.modules[0]!.id}/sessions`,
      {},
    )

    const driver = await connect(ada.cookie)
    const spectator = await connect(bob.cookie)

    driver.send({ t: 'sub_project', projectId: project.id })
    spectator.send({ t: 'sub_project', projectId: project.id })
    driver.send({ t: 'sub', sessionId: session.id })
    spectator.send({ t: 'sub', sessionId: session.id })

    // presence eventually shows both users
    await driver.waitFor(
      (m) => m.t === 'presence' && m.users.length === 2,
    )

    // driver sends a message over WS; spectator sees the whole turn live
    driver.send({ t: 'user_message', sessionId: session.id, text: 'Build the hero section' })

    await spectator.waitFor((m) => m.t === 'event' && m.event.type === 'commit')
    await spectator.waitFor(
      (m) => m.t === 'event' && m.event.type === 'status' && m.event.payload.status === 'idle' && (m.event.seq ?? 0) > 3,
    )

    const spectatorEventTypes = spectator.messages.filter((m) => m.t === 'event').map((m) => (m.t === 'event' ? m.event.type : ''))
    expect(spectatorEventTypes).toContain('user_message')
    expect(spectatorEventTypes).toContain('assistant_delta') // live streaming reached the spectator
    expect(spectatorEventTypes).toContain('tool_call')
    expect(spectatorEventTypes).toContain('file_change')
    expect(spectatorEventTypes).toContain('commit')

    // project feed carried liveness gists and the change
    const driverUpdates = driver.messages.filter((m) => m.t === 'project_update')
    expect(driverUpdates.some((m) => m.t === 'project_update' && m.update.kind === 'session_activity')).toBe(true)
    expect(driverUpdates.some((m) => m.t === 'project_update' && m.update.kind === 'change')).toBe(true)

    // spectator cannot drive
    spectator.send({ t: 'user_message', sessionId: session.id, text: 'I drive now' })
    const err = await spectator.waitFor((m) => m.t === 'error')
    expect(err.t === 'error' && err.message).toMatch(/driver|fork/i)

    // catchup replays persisted events in order (no deltas)
    const late = await connect(bob.cookie)
    late.send({ t: 'catchup', sessionId: session.id, afterSeq: 0 })
    const batch = await late.waitFor((m) => m.t === 'catchup_batch')
    if (batch.t !== 'catchup_batch') throw new Error('unreachable')
    expect(batch.events.length).toBeGreaterThan(5)
    expect(batch.events.every((e) => e.type !== 'assistant_delta')).toBe(true)
    const seqs = batch.events.map((e) => e.seq)
    expect([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(seqs)

    // membership is enforced for subscriptions
    const mallory = await signupViaHttp('Mallory', 'mallory@rt.dev')
    const outsider = await connect(mallory.cookie)
    outsider.send({ t: 'sub', sessionId: session.id })
    const forbidden = await outsider.waitFor((m) => m.t === 'error')
    expect(forbidden.t === 'error' && forbidden.code).toBe('forbidden')

    driver.close()
    spectator.close()
    late.close()
    outsider.close()
  })
})
