import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

async function signup(name: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password-123' }),
  })
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('replay endpoint (integration)', () => {
  it('returns the full persisted log for a member, gated for everyone else', async () => {
    const cookie = await signup('Ada', 'ada@replay.dev')
    const { services } = ctx
    const user = await services.auth.login('ada@replay.dev', 'password-123')
    const project = await services.projects.createProject('Replayable', '', user!)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user!)
    await (await services.orchestrator.handleUserMessage(session.id, user!, 'Build the hero section')).done

    // member gets the snapshot: session meta + the full event log (no deltas)
    const res = await fetch(`${base}/api/replay/${session.id}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const detail = (await res.json()) as {
      session: { id: string; title: string }
      moduleName: string
      events: Array<{ type: string; seq: number | null }>
      lastSeq: number
    }
    expect(detail.session.id).toBe(session.id)
    expect(detail.events.length).toBeGreaterThan(3)
    expect(detail.events.every((e) => e.type !== 'assistant_delta')).toBe(true)
    expect(detail.events.some((e) => e.type === 'commit')).toBe(true)
    // strictly increasing seq
    const seqs = detail.events.map((e) => e.seq)
    expect([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(seqs)
    expect(detail.lastSeq).toBe(seqs[seqs.length - 1])

    // unauthenticated → 401 (this is the seam a future signed link plugs into)
    const anon = await fetch(`${base}/api/replay/${session.id}`)
    expect(anon.status).toBe(401)

    // authenticated non-member → 403
    const outsider = await signup('Mallory', 'mallory@replay.dev')
    const forbidden = await fetch(`${base}/api/replay/${session.id}`, { headers: { cookie: outsider } })
    expect(forbidden.status).toBe(403)

    // unknown session → 404
    const missing = await fetch(`${base}/api/replay/nope`, { headers: { cookie } })
    expect(missing.status).toBe(404)
  })
})
