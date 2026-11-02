import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentTurnContext } from '@loom/shared'
import { makeTestServices, makeUser, type TestContext } from './util'

/**
 * Runs on BOTH repo backends: `pnpm test` exercises real git; with
 * LOOM_PLATFORM=serverless the same assertions exercise the DB-backed repo.
 */
let ctx: TestContext
beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

const writes = (files: Record<string, string>): AgentProvider => ({
  async *runTurn(turn: AgentTurnContext) {
    for (const [path, content] of Object.entries(files)) {
      yield { kind: 'tool_call', name: 'write_file', input: { path, content } }
      await turn.executeTool('write_file', { path, content })
    }
    yield { kind: 'message_done', fullText: 'done' }
  },
})

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)

async function setup() {
  const { services } = ctx
  const ada = await makeUser(services, 'Ada', 'ada@merge.dev')
  const project = await services.projects.createProject('Merges', '', ada)
  const [landing] = await services.projects.listModules(project.id)
  // a shared base file on main
  const base = await services.sessions.createSession(landing!.id, ada)
  services.runtime.provider = writes({ 'page.txt': LINES.join('\n') + '\n' })
  const t = await services.orchestrator.handleUserMessage(base.id, ada, 'base')
  if (t.ok) await t.done
  expect((await services.merge.mergeBranch(project.id, base.branchName, ada)).merged).toBe(true)
  return { services, ada, project, moduleId: landing!.id }
}

/** two sessions cut from the same commit (created before either writes), each then edits */
async function divergent(s: Awaited<ReturnType<typeof setup>>, filesA: Record<string, string>, filesB: Record<string, string>) {
  const a = await s.services.sessions.createSession(s.moduleId, s.ada)
  const b = await s.services.sessions.createSession(s.moduleId, s.ada)
  for (const [session, files] of [[a, filesA], [b, filesB]] as const) {
    s.services.runtime.provider = writes(files)
    const t = await s.services.orchestrator.handleUserMessage(session.id, s.ada, 'edit')
    if (t.ok) await t.done
  }
  return [a, b] as const
}

describe(`merging into main (${process.env.LOOM_PLATFORM === 'serverless' ? 'DB repo' : 'git'})`, () => {
  it('combines edits to different parts of the same file, and reports the true ahead/behind', async () => {
    const s = await setup()
    const top = LINES.map((l, i) => (i === 0 ? 'TOP EDIT' : l)).join('\n') + '\n'
    const bottom = LINES.map((l, i) => (i === 11 ? 'BOTTOM EDIT' : l)).join('\n') + '\n'
    const [a, b] = await divergent(s, { 'page.txt': top }, { 'page.txt': bottom, 'extra.txt': 'new\n' })
    const git = s.services.projects.gitFor(s.project)
    // sessions branch from the module's latest commit, so b also carries the base session's work
    const before = await git.aheadBehind(b.branchName)
    expect(before.behind).toBe(0)
    expect(before.ahead).toBeGreaterThanOrEqual(1)

    expect((await s.services.merge.mergeBranch(s.project.id, a.branchName, s.ada)).hadConflicts).toBe(false)
    expect((await git.aheadBehind(b.branchName)).behind).toBeGreaterThan(0)
    const rb = await s.services.merge.mergeBranch(s.project.id, b.branchName, s.ada)
    expect(rb).toMatchObject({ ok: true, merged: true, hadConflicts: false })

    const merged = await git.showFile('main', 'page.txt')
    expect(merged).toContain('TOP EDIT')
    expect(merged).toContain('BOTTOM EDIT')
    expect(await git.listFilesAtRef('main')).toEqual(expect.arrayContaining(['README.md', 'page.txt', 'extra.txt']))
    // merging again is a no-op
    expect((await s.services.merge.mergeBranch(s.project.id, b.branchName, s.ada)).merged).toBe(false)
  })

  it('a real conflict is reported honestly and resolved to the incoming side in mock mode', async () => {
    const s = await setup()
    const [a, b] = await divergent(
      s,
      { 'page.txt': LINES.map((l, i) => (i === 5 ? 'ADA WAS HERE' : l)).join('\n') + '\n' },
      { 'page.txt': LINES.map((l, i) => (i === 5 ? 'BOB WAS HERE' : l)).join('\n') + '\n' },
    )
    await s.services.merge.mergeBranch(s.project.id, a.branchName, s.ada)
    const res = await s.services.merge.mergeBranch(s.project.id, b.branchName, s.ada)
    expect(res).toMatchObject({ ok: true, merged: true, hadConflicts: true })
    expect(res.message).toMatch(/page\.txt/)
    const git = s.services.projects.gitFor(s.project)
    const merged = await git.showFile('main', 'page.txt')
    expect(merged).toContain('BOB WAS HERE')
    expect(merged).not.toMatch(/<{7}|>{7}/)
    // the merge commit's stats describe what landed on main
    const [head] = await git.log('main', 1)
    expect(head!.subject).toMatch(/conflicts resolved/)
  })
})
