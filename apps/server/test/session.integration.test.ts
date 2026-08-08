import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/git/gitService'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext

beforeEach(async () => {
  ctx = await makeTestServices()
})

afterEach(async () => {
  await ctx.cleanup()
})

describe('full mock session (integration)', () => {
  it('drives a turn end to end: events persisted, files on disk, commit in git log', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Ada', 'ada@test.dev')
    const project = await services.projects.createProject('Testly', 'A test product', user)
    const modules = await services.projects.listModules(project.id)
    const landing = modules.find((m) => m.name === 'Landing page')!
    const session = await services.sessions.createSession(landing.id, user)

    const res = await services.orchestrator.handleUserMessage(
      session.id,
      user,
      'Build a hero section with our name and a waitlist form',
    )
    expect(res.ok).toBe(true)
    await res.done

    // --- events persisted, in strict seq order, all key types present
    const events = await services.sessions.getEvents(session.id)
    const types = events.map((e) => e.type)
    for (const required of ['user_message', 'status', 'tool_call', 'tool_result', 'assistant_message', 'file_change', 'commit']) {
      expect(types).toContain(required)
    }
    expect(types).not.toContain('assistant_delta') // broadcast-only, never persisted
    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...Array(events.length)].map((_, i) => i + 1))

    // tool_call precedes its tool_result; commit is after file_change
    expect(types.indexOf('tool_call')).toBeLessThan(types.indexOf('tool_result'))
    expect(types.indexOf('file_change')).toBeLessThan(types.indexOf('commit'))

    // --- files really on disk in the session worktree
    expect(fs.existsSync(path.join(session.worktreePath, 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(session.worktreePath, 'styles.css'))).toBe(true)
    const html = fs.readFileSync(path.join(session.worktreePath, 'index.html'), 'utf8')
    expect(html).toContain('Testly')
    expect(html).toContain('waitlist')

    // --- commit really in git log, authored by the driver
    const git = new GitService(project.repoPath)
    const log = await git.log(session.branchName)
    expect(log.length).toBe(2) // initial + agent turn
    expect(log[0]!.authorName).toBe('Ada')

    // --- change row with technical + plain summaries
    const changes = await services.projects.listChanges(project.id)
    expect(changes.length).toBe(1)
    expect(changes[0]!.commitSha).toBe(log[0]!.sha)
    expect(changes[0]!.plainExplanation).toContain('Ada')
    expect(changes[0]!.filesChanged.map((f) => f.path).sort()).toEqual(['index.html', 'styles.css'])

    // --- commit event references the change row
    const commitEvent = events.find((e) => e.type === 'commit')!
    expect(commitEvent.type === 'commit' && commitEvent.payload.changeId).toBe(changes[0]!.id)
  })

  it('rejects concurrent turns and non-driver messages', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Ada', 'ada2@test.dev')
    const stranger = await makeUser(services, 'Mallory', 'mallory@test.dev')
    const project = await services.projects.createProject('Testly', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    const first = await services.orchestrator.handleUserMessage(session.id, user, 'Start building')
    expect(first.ok).toBe(true)
    const second = await services.orchestrator.handleUserMessage(session.id, user, 'Interrupt!')
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/still working/)

    const intruder = await services.orchestrator.handleUserMessage(session.id, stranger, 'let me drive')
    expect(intruder.ok).toBe(false)
    expect(intruder.error).toMatch(/driver/)

    await first.done

    const ended = await services.sessions.getSession(session.id)
    expect(ended!.status).toBe('idle')
  })

  it('the mock provider exercises multiple modules sensibly', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Ada', 'ada3@test.dev')
    const project = await services.projects.createProject('Testly', '', user)
    const custom = await services.projects.createModule(project.id, { name: 'Billing', emoji: '💳' })
    const session = await services.sessions.createSession(custom.id, user)

    const res = await services.orchestrator.handleUserMessage(session.id, user, 'Sketch the invoices list')
    await res.done
    expect(fs.existsSync(path.join(session.worktreePath, 'billing.html'))).toBe(true)
    const content = fs.readFileSync(path.join(session.worktreePath, 'billing.html'), 'utf8')
    expect(content).toContain('invoices list') // user intent echoed into the artifact

    const res2 = await services.orchestrator.handleUserMessage(session.id, user, 'Add a totals row')
    await res2.done
    const after = fs.readFileSync(path.join(session.worktreePath, 'billing.html'), 'utf8')
    expect((after.match(/<section/g) ?? []).length).toBeGreaterThan(
      (content.match(/<section/g) ?? []).length,
    )
  })
})
