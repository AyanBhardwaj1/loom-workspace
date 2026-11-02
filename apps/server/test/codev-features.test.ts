import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider } from '@loom/shared'
import { buildApp } from '../src/app'
import { SESSION_COOKIE, signValue } from '../src/auth/cookies'
import { makeTestServices, makeUser, type TestContext } from './util'

/** Board, live main, the duplicate-task check, and Loom as an MCP server for laptop agents. */
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
const writes = (files: Record<string, string>): AgentProvider => ({
  async *runTurn(turn) {
    for (const [path, content] of Object.entries(files)) {
      yield { kind: 'tool_call', name: 'write_file', input: { path, content } }
      await turn.executeTool('write_file', { path, content })
    }
    yield { kind: 'message_done', fullText: 'done' }
  },
})

async function world() {
  const { services } = ctx
  const ayan = await makeUser(services, 'Ayan', 'ayan@cd.dev')
  const sai = await makeUser(services, 'Sai', 'sai@cd.dev')
  const leo = await makeUser(services, 'Leo', 'leo@cd.dev')
  const project = await services.projects.createProject('Synced', '', ayan)
  await services.projects.addMemberByEmail(project.id, 'sai@cd.dev')
  await services.projects.addMemberByEmail(project.id, 'leo@cd.dev')
  const [mod] = await services.projects.listModules(project.id)
  const base = await services.sessions.createSession(mod!.id, ayan)
  services.runtime.provider = writes({ 'index.html': '<!doctype html><html lang="en"><head><title>x</title><meta name="viewport" content="width=device-width"></head><body><h1>Synced</h1></body></html>', 'app.js': APP })
  let t = await services.orchestrator.handleUserMessage(base.id, ayan, 'base')
  if (t.ok) await t.done
  await services.merge.mergeBranch(project.id, base.branchName, sai)
  await services.sessions.endSession(base.id)
  const a = await services.sessions.createSession(mod!.id, ayan)
  const b = await services.sessions.createSession(mod!.id, sai)
  const c = await services.sessions.createSession(mod!.id, leo)
  const turn = async (s: { id: string }, u: typeof ayan, files: Record<string, string>, text = 'work') => {
    services.runtime.provider = writes(files)
    t = await services.orchestrator.handleUserMessage(s.id, u, text)
    if (t.ok) await t.done
  }
  const app = await buildApp(services)
  const cookie = async (id: string) => ({ [SESSION_COOKIE]: signValue(await services.auth.createAuthSession(id), ctx.config.cookieSecret) })
  return { services, ayan, sai, leo, project, a, b, c, turn, app, cookie }
}

describe('live main and the board', () => {
  it('combines everyone’s work in arrival order; work that collides "doesn’t fit yet" and names whose; preview serves the combination', async () => {
    const w = await world()
    try {
      await w.turn(w.a, w.ayan, { 'app.js': APP.replace("'Hi'", "'Hello from Ayan'") })
      await w.turn(w.b, w.sai, { 'app.js': APP.replace("'Bye'", "'Bye from Sai'") })
      await w.turn(w.c, w.leo, { 'app.js': APP.replace("'Hi'", "'Hey from Leo'") })
      const lm = (await w.app.inject({ method: 'GET', url: `/api/projects/${w.project.id}/live-main`, cookies: await w.cookie(w.ayan.id) })).json() as {
        entries: Array<{ userName: string; status: string; collidesWith: string[]; conflicts: Array<{ path: string; symbols: string[] }> }>
        checks: { status: string } | null
      }
      const by = Object.fromEntries(lm.entries.map((e) => [e.userName, e]))
      expect(by.Ayan!.status).toBe('in-live-main')
      expect(by.Sai!.status).toBe('in-live-main')
      expect(by.Leo).toMatchObject({ status: 'doesnt-fit', collidesWith: ['Ayan'], conflicts: [{ path: 'app.js', symbols: ['renderHero'] }] })
      expect(lm.checks?.status).toBeTruthy()

      // the combined app is previewable
      const js = await w.app.inject({ method: 'GET', url: `/preview/live/${w.project.id}/app.js`, cookies: await w.cookie(w.sai.id) })
      expect(js.statusCode).toBe(200)
      expect(js.body).toContain('Hello from Ayan')
      expect(js.body).toContain('Bye from Sai')
      expect(js.body).not.toContain('Leo')

      // the board: lanes, branch vs main, overlaps and conflicts per card
      const board = (await w.app.inject({ method: 'GET', url: `/api/projects/${w.project.id}/board`, cookies: await w.cookie(w.leo.id) })).json() as {
        cards: Array<{ driver: { name: string }; lane: string; main: { status: string }; overlaps: Array<{ withName: string; conflicts: unknown[] }> }>
        openConflicts: number
      }
      const leoCard = board.cards.find((c) => c.driver.name === 'Leo')!
      expect(leoCard.lane).toBe('needs-you') // an open conflict needs a human
      expect(leoCard.overlaps.find((o) => o.withName === 'Ayan')!.conflicts.length).toBeGreaterThan(0)
      expect(board.cards.find((c) => c.driver.name === 'Sai')!.lane).toBe('to-review')
      expect(board.openConflicts).toBeGreaterThan(0)
    } finally {
      await w.app.close()
    }
  })

  it('warns before starting a task someone else is already doing', async () => {
    const w = await world()
    try {
      await w.turn(w.a, w.ayan, { 'app.js': APP.replace("'Hi'", "'Hello'") }, 'Add a waitlist signup form to the landing hero')
      const res = (
        await w.app.inject({ method: 'POST', url: `/api/sessions/${w.b.id}/similar`, cookies: await w.cookie(w.sai.id), payload: { text: 'build a waitlist signup form in the hero' } })
      ).json() as { matches: Array<{ driverName: string; sessionId: string }> }
      expect(res.matches[0]).toMatchObject({ driverName: 'Ayan', sessionId: w.a.id })
      const none = (await w.app.inject({ method: 'POST', url: `/api/sessions/${w.b.id}/similar`, cookies: await w.cookie(w.sai.id), payload: { text: 'dark mode toggle in settings' } })).json() as {
        matches: unknown[]
      }
      expect(none.matches).toEqual([])
    } finally {
      await w.app.close()
    }
  })
})

describe('Loom as an MCP server for laptop agents', () => {
  it('a token-authenticated agent announces its work, reads the radar, and suggests — but never steers', async () => {
    const w = await world()
    try {
      await w.turn(w.a, w.ayan, { 'app.js': APP.replace("'Hi'", "'Hello from Ayan'") })
      const made = (await w.app.inject({ method: 'POST', url: '/api/agent-tokens', cookies: await w.cookie(w.sai.id), payload: { name: 'MacBook Claude Code' } })).json() as { token: string }
      expect(made.token).toMatch(/^loom_pat_/)
      const rpc = (body: unknown, token = made.token) =>
        w.app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: body as object })

      expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, 'loom_pat_nope')).statusCode).toBe(401)
      const init = (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json() as { result: { serverInfo: { name: string }; instructions: string } }
      expect(init.result.serverInfo.name).toBe('loom')
      expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202)
      const tools = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as { result: { tools: Array<{ name: string }> } }
      expect(tools.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['loom_announce', 'loom_radar', 'loom_suggest', 'loom_live_main']))

      const call = async (name: string, args: Record<string, unknown>) =>
        ((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).json() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result
      const announced = await call('loom_announce', {
        projectId: w.project.id,
        branch: 'sai/hero-copy',
        agent: 'claude-code',
        summary: 'Hero copy',
        files: [{ path: 'app.js', symbols: ['renderHero'] }],
      })
      expect(announced.content[0]!.text).toMatch(/Ayan & Sai both change app\.js: CONFLICT in app\.js › renderHero/)

      // the Loom room sees the laptop agent
      const board = (await w.app.inject({ method: 'GET', url: `/api/projects/${w.project.id}/board`, cookies: await w.cookie(w.ayan.id) })).json() as { external: Array<{ userName: string; branchName: string }> }
      expect(board.external).toEqual([expect.objectContaining({ userName: 'Sai', branchName: 'sai/hero-copy' })])

      // reading is fine; acting goes through the driver
      expect((await call('loom_read_file', { projectId: w.project.id, path: 'app.js', sessionId: w.a.id })).content[0]!.text).toContain('Hello from Ayan')
      expect((await call('loom_suggest', { sessionId: w.a.id, text: 'Keep the hero copy short' })).content[0]!.text).toMatch(/driver sees it/)
      const events = await w.services.sessions.getEvents(w.a.id, 0)
      expect(events.some((e) => e.type === 'suggestion' && e.payload.suggesterName === 'Sai')).toBe(true)
      expect(events.filter((e) => e.type === 'user_message').length).toBe(1) // nothing ran

      // a stranger's project is invisible
      expect((await call('loom_radar', { projectId: 'nope' })).isError).toBe(true)
      // cleared announcements disappear
      await call('loom_announce', { projectId: w.project.id, branch: 'sai/hero-copy', files: [] })
      const after = (await w.app.inject({ method: 'GET', url: `/api/projects/${w.project.id}/board`, cookies: await w.cookie(w.ayan.id) })).json() as { external: unknown[] }
      expect(after.external).toEqual([])
    } finally {
      await w.app.close()
    }
  })
})
