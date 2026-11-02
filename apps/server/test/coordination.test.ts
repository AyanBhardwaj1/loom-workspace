import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentToolExecution, AgentTurnContext } from '@loom/shared'
import { makeTestServices, makeUser, type TestContext } from './util'

/**
 * Agents that keep each other posted: the radar briefs an agent on teammates'
 * work, tells it at the tool boundary when a test-merge finds a conflict, and
 * records the conflict — and its resolution — in both sessions' logs.
 */
let ctx: TestContext
beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

const APP = `export function renderHero(el) {
  el.title = 'Hi'
  return el
}

export function renderFooter(el) {
  el.text = 'Bye'
  return el
}
`

/** writes files in order; records what each tool result told the agent and the turn context */
const writer = (files: Record<string, string>, seen: { results: AgentToolExecution[]; turn?: AgentTurnContext }): AgentProvider => ({
  async *runTurn(turn) {
    seen.turn = turn
    for (const [path, content] of Object.entries(files)) {
      yield { kind: 'tool_call', name: 'write_file', input: { path, content } }
      seen.results.push(await turn.executeTool('write_file', { path, content }))
    }
    yield { kind: 'message_done', fullText: 'done' }
  },
})

async function world() {
  const { services } = ctx
  const ayan = await makeUser(services, 'Ayan', 'ayan@coord.dev')
  const sai = await makeUser(services, 'Sai', 'sai@coord.dev')
  const project = await services.projects.createProject('Coordinated', '', ayan)
  await services.projects.addMemberByEmail(project.id, 'sai@coord.dev')
  const [mod] = await services.projects.listModules(project.id)
  // a shared base on main
  const base = await services.sessions.createSession(mod!.id, ayan)
  services.runtime.provider = writer({ 'app.js': APP }, { results: [] })
  const t = await services.orchestrator.handleUserMessage(base.id, ayan, 'base')
  if (t.ok) await t.done
  await services.merge.mergeBranch(project.id, base.branchName, sai)
  await services.sessions.endSession(base.id)
  // two sessions cut from the same commit
  const a = await services.sessions.createSession(mod!.id, ayan)
  const b = await services.sessions.createSession(mod!.id, sai)
  return { services, ayan, sai, project, a, b }
}

const run = async (w: Awaited<ReturnType<typeof world>>, session: { id: string }, user: typeof w.ayan, files: Record<string, string>) => {
  const seen: { results: AgentToolExecution[]; turn?: AgentTurnContext } = { results: [] }
  w.services.runtime.provider = writer(files, seen)
  const t = await w.services.orchestrator.handleUserMessage(session.id, user, 'work')
  if (t.ok) await t.done
  return seen
}

const coordEvents = async (w: Awaited<ReturnType<typeof world>>, sessionId: string) =>
  (await w.services.sessions.getEvents(sessionId, 0)).flatMap((e) => (e.type === 'coordination' ? [e.payload] : []))

describe('agent coordination radar', () => {
  it('briefs, catches a same-function conflict mid-turn (both logs), and resolves it when the agent adapts', async () => {
    const w = await world()
    await run(w, w.a, w.ayan, { 'app.js': APP.replace("'Hi'", "'Hello from Ayan'") })

    // Sai's agent: briefed at turn start, then told at the tool boundary that renderHero collides
    const seen = await run(w, w.b, w.sai, { 'app.js': APP.replace("'Hi'", "'Hello from Sai'") })
    // at turn start Sai's agent hasn't changed anything yet: it hears what Ayan's agent is in
    expect(seen.turn?.coordination).toMatch(/Ayan's agent \(in Loom session ".*", branch .*\): app\.js › renderHero/)
    expect(seen.results[0]!.content).toMatch(/\[COORDINATION — a test-merge found your change conflicts with Ayan's work .*app\.js › renderHero/)

    const bEvents = await coordEvents(w, w.b.id)
    const conflict = bEvents.find((e) => e.kind === 'conflict')!
    expect(conflict).toMatchObject({ against: 'session', withName: 'Ayan', items: [{ path: 'app.js', symbols: ['renderHero'] }] })
    // the other room hears it too
    expect((await coordEvents(w, w.a.id)).find((e) => e.kind === 'conflict')).toMatchObject({ key: conflict.key, withName: 'Sai' })

    // Sai's agent adapts: leaves renderHero alone, changes the footer instead → resolved in both logs
    const again = await run(w, w.b, w.sai, { 'app.js': APP.replace("'Bye'", "'See you, from Sai'") })
    // now both are in app.js: the turn-start briefing says so, and is recorded for the room
    expect(again.turn?.coordination).toMatch(/is ALSO changing app\.js/)
    expect((await coordEvents(w, w.b.id)).some((e) => e.kind === 'briefing' && e.withName === 'Ayan')).toBe(true)
    expect((await coordEvents(w, w.b.id)).find((e) => e.kind === 'resolved')).toMatchObject({ key: conflict.key })
    expect((await coordEvents(w, w.a.id)).find((e) => e.kind === 'resolved')).toMatchObject({ key: conflict.key })

    // and the radar now sees an overlap that merges cleanly
    const radar = await w.services.radar.forProject(w.project.id, { fresh: true })
    const ov = radar.overlaps.find((o) => o.files.includes('app.js'))!
    expect(ov.conflicts).toEqual([])
  })

  it('reports each branch against main, and laptop agents’ announced work by symbol', async () => {
    const w = await world()
    await run(w, w.a, w.ayan, { 'app.js': APP.replace("'Hi'", "'Hello'") })
    const radar0 = await w.services.radar.forProject(w.project.id, { fresh: true })
    expect(radar0.vsMain[`session:${w.a.id}`]).toMatchObject({ status: 'ready' })
    expect(radar0.vsMain[`session:${w.b.id}`]).toMatchObject({ status: 'up-to-date' })

    // Sai's laptop agent announces it is editing renderHero (names only, no contents)
    const { db, t } = w.services.dbh
    await db.insert(t.externalWork).values({
      id: 'ext-1',
      userId: w.sai.id,
      projectId: w.project.id,
      agent: 'claude-code',
      branch: 'sai/hero',
      files: JSON.stringify([{ path: 'app.js', symbols: ['renderHero'] }]),
      summary: 'Hero copy',
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const radar = await w.services.radar.forProject(w.project.id, { fresh: true })
    const ov = radar.overlaps.find((o) => o.b === 'external:ext-1' || o.a === 'external:ext-1')!
    expect(ov.conflicts).toEqual([{ path: 'app.js', symbols: ['renderHero'] }])
    const brief = w.services.radar.briefingFor(radar, `session:${w.a.id}`)
    expect(brief.text).toMatch(/Sai's agent \(on their computer, branch sai\/hero\) is ALSO changing app\.js/)
  })
})
