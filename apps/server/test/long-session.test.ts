import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext

beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

/**
 * Gate 10 — the ≥5,000-event fixture. The client renders ~30 virtualized
 * rows regardless of log length; the server side must read and page the log
 * fast enough that catchup and replay stay responsive.
 */
describe('long sessions (5,000-event fixture)', () => {
  it('reads the full log quickly and catchup slices O(tail)', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Long', 'long@fixture.dev')
    const project = await services.projects.createProject('Marathon', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    // seed 5,000 events straight through the db (the append path is
    // one-at-a-time by design; the fixture only needs the rows to exist)
    const { db, t } = services.dbh
    const base = Date.now()
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: ulid(base + i),
      sessionId: session.id,
      seq: i + 2, // seq 1 is the session-started note
      type: i % 2 === 0 ? 'user_message' : 'assistant_message',
      payload: JSON.stringify({ text: `event ${i}` }),
      createdAt: new Date(base + i).toISOString(),
    }))
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(t.sessionEvents).values(rows.slice(i, i + 500))
    }

    const t0 = performance.now()
    const all = await services.sessions.getEvents(session.id, 0, 10_000)
    const fullMs = performance.now() - t0
    expect(all.length).toBeGreaterThanOrEqual(5000)
    expect(fullMs).toBeLessThan(2000) // full replay read stays interactive

    // catchup from a late cursor returns only the tail, quickly
    const t1 = performance.now()
    const tail = await services.sessions.getEvents(session.id, 4900)
    const tailMs = performance.now() - t1
    expect(tail.length).toBeLessThanOrEqual(all.length - 4800)
    expect(tail.length).toBeGreaterThan(0)
    expect(tailMs).toBeLessThan(200)
  })
})
