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

describe('fork mechanics', () => {
  it('forks at an event: log copied, branch cut at that commit, source completely unaffected', async () => {
    const { services } = ctx
    const ada = await makeUser(services, 'Ada', 'ada@fork.dev')
    const bob = await makeUser(services, 'Bob', 'bob@fork.dev')
    const project = await services.projects.createProject('Forkly', '', ada)
    await services.projects.addMemberByEmail(project.id, 'bob@fork.dev')
    const modules = await services.projects.listModules(project.id)
    const landing = modules.find((m) => m.name === 'Landing page')!
    const session = await services.sessions.createSession(landing.id, ada)

    // turn 1: hero; turn 2: features grid
    await (await services.orchestrator.handleUserMessage(session.id, ada, 'Build the hero section with a waitlist form')).done
    await (await services.orchestrator.handleUserMessage(session.id, ada, 'Now add a features grid below the hero')).done

    const sourceEvents = await services.sessions.getEvents(session.id)
    const commits = sourceEvents.filter((e) => e.type === 'commit')
    expect(commits.length).toBe(2)
    const firstCommit = commits[0]!
    const sourceHtmlBefore = fs.readFileSync(path.join(session.worktreePath, 'index.html'), 'utf8')
    expect(sourceHtmlBefore).toContain('feature-grid')

    // --- fork at the first commit (i.e. before the features grid existed)
    const fork = await services.sessions.forkSession(session.id, bob, firstCommit.id)
    expect(fork.parentSessionId).toBe(session.id)
    expect(fork.forkedAtEventId).toBe(firstCommit.id)
    expect(fork.branchName).not.toBe(session.branchName)
    expect(fork.worktreePath).not.toBe(session.worktreePath)

    // fork log: leading "forked from" status + filtered copy of the source
    // events up to the cutoff (transient thinking/running_tools statuses are
    // dropped — the fork must never inherit a busy composer) + trailing idle
    const forkEvents = await services.sessions.getEvents(fork.id)
    expect(forkEvents[0]!.type).toBe('status')
    expect(JSON.stringify(forkEvents[0]!.payload)).toContain('Forked from Ada')
    const cutoffIndex = sourceEvents.findIndex((e) => e.id === firstCommit.id)
    const expectedCopied = sourceEvents
      .slice(0, cutoffIndex + 1)
      .filter(
        (e) =>
          !(e.type === 'status' && (e.payload.status === 'thinking' || e.payload.status === 'running_tools')),
      )
    expect(forkEvents.length).toBe(expectedCopied.length + 2)
    for (let i = 0; i < expectedCopied.length; i++) {
      const copied = forkEvents[i + 1]!
      expect(copied.type).toBe(expectedCopied[i]!.type)
      expect(copied.payload).toEqual(expectedCopied[i]!.payload)
      expect(copied.id).not.toBe(expectedCopied[i]!.id) // fresh ids
      expect(copied.seq).toBe(i + 2) // contiguous seq in the new log
    }
    const trailing = forkEvents[forkEvents.length - 1]!
    expect(trailing.type).toBe('status')
    expect(trailing.type === 'status' && trailing.payload.status).toBe('idle')

    // fork worktree = code state at the fork point (hero yes, features no)
    const forkHtml = fs.readFileSync(path.join(fork.worktreePath, 'index.html'), 'utf8')
    expect(forkHtml).toContain('waitlist')
    expect(forkHtml).not.toContain('feature-grid')
    const git = new GitService(project.repoPath)
    expect(await git.currentSha(fork.branchName)).toBe(
      firstCommit.type === 'commit' ? firstCommit.payload.commitSha : '',
    )

    // --- source is unaffected except the fork_marker appended for spectators
    const sourceAfter = await services.sessions.getEvents(session.id)
    expect(sourceAfter.length).toBe(sourceEvents.length + 1)
    const marker = sourceAfter[sourceAfter.length - 1]!
    expect(marker.type).toBe('fork_marker')
    expect(marker.type === 'fork_marker' && marker.payload.byUserName).toBe('Bob')
    expect(sourceAfter.slice(0, sourceEvents.length).map((e) => e.id)).toEqual(sourceEvents.map((e) => e.id))
    expect(fs.readFileSync(path.join(session.worktreePath, 'index.html'), 'utf8')).toBe(sourceHtmlBefore)

    // --- both sessions continue independently
    await (await services.orchestrator.handleUserMessage(fork.id, bob, 'Add a features grid below the hero')).done
    await (await services.orchestrator.handleUserMessage(session.id, ada, 'Finish with a footer')).done

    const forkFinal = fs.readFileSync(path.join(fork.worktreePath, 'index.html'), 'utf8')
    const sourceFinal = fs.readFileSync(path.join(session.worktreePath, 'index.html'), 'utf8')
    expect(forkFinal).toContain('feature-grid')
    expect(forkFinal).not.toContain('site-footer')
    expect(sourceFinal).toContain('site-footer')

    // git histories diverged from the fork point
    const forkLog = await services.projects.gitFor(project).log(fork.branchName)
    const sourceLog = await services.projects.gitFor(project).log(session.branchName)
    expect(forkLog.map((c) => c.sha)).not.toEqual(sourceLog.map((c) => c.sha))
    // fork commit authored by Bob, source's newest by Ada
    expect(forkLog[0]!.authorName).toBe('Bob')
    expect(sourceLog[0]!.authorName).toBe('Ada')
  })

  it('forks with no atEventId default to the latest event', async () => {
    const { services } = ctx
    const ada = await makeUser(services, 'Ada', 'ada2@fork.dev')
    const bob = await makeUser(services, 'Bob', 'bob2@fork.dev')
    const project = await services.projects.createProject('Forkly2', '', ada)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, ada)
    await (await services.orchestrator.handleUserMessage(session.id, ada, 'Build the hero')).done

    const fork = await services.sessions.forkSession(session.id, bob)
    const sourceEvents = await services.sessions.getEvents(session.id)
    const forkEvents = await services.sessions.getEvents(fork.id)
    // structure: lead "forked from" status, the source's story (no transient
    // statuses, no fork_marker — that was appended after the copy), final idle
    expect(forkEvents[0]!.type).toBe('status')
    expect(forkEvents[forkEvents.length - 1]!.type).toBe('status')
    const forkPayloads = forkEvents.map((e) => JSON.stringify(e.payload))
    for (const e of sourceEvents) {
      if (e.type === 'user_message' || e.type === 'assistant_message' || e.type === 'commit') {
        expect(forkPayloads).toContain(JSON.stringify(e.payload))
      }
    }
    expect(forkEvents.some((e) => e.type === 'fork_marker')).toBe(false)
    expect(forkEvents.map((e) => e.seq)).toEqual(forkEvents.map((_, i) => i + 1))
    expect(fs.existsSync(path.join(fork.worktreePath, 'index.html'))).toBe(true)
  })

  it('forking mid-turn never inherits a busy composer state', async () => {
    const { services } = ctx
    const ada = await makeUser(services, 'Ada', 'ada4@fork.dev')
    const bob = await makeUser(services, 'Bob', 'bob4@fork.dev')
    const project = await services.projects.createProject('Forkly4', '', ada)
    const modules = await services.projects.listModules(project.id)
    const landing = modules.find((m) => m.name === 'Landing page')!
    const session = await services.sessions.createSession(landing.id, ada)
    await (await services.orchestrator.handleUserMessage(session.id, ada, 'Build the hero section')).done

    const events = await services.sessions.getEvents(session.id)
    // fork exactly at a tool_call — the row the "⑂ fork here" affordance offers
    const toolCall = events.find((e) => e.type === 'tool_call')!
    const fork = await services.sessions.forkSession(session.id, bob, toolCall.id)
    const forkEvents = await services.sessions.getEvents(fork.id)

    const statuses = forkEvents.filter((e) => e.type === 'status')
    const last = statuses[statuses.length - 1]!
    expect(last.type === 'status' && last.payload.status).toBe('idle')
    expect(
      forkEvents.some(
        (e) => e.type === 'status' && (e.payload.status === 'thinking' || e.payload.status === 'running_tools'),
      ),
    ).toBe(false)
    // and the new driver can actually drive
    const res = await services.orchestrator.handleUserMessage(fork.id, bob, 'Keep going from here')
    expect(res.ok).toBe(true)
    await res.done
  })

  it('forking before the first commit rewinds the worktree to the branch base', async () => {
    const { services } = ctx
    const ada = await makeUser(services, 'Ada', 'ada5@fork.dev')
    const bob = await makeUser(services, 'Bob', 'bob5@fork.dev')
    const project = await services.projects.createProject('Forkly5', '', ada)
    const modules = await services.projects.listModules(project.id)
    const landing = modules.find((m) => m.name === 'Landing page')!
    const session = await services.sessions.createSession(landing.id, ada)
    await (await services.orchestrator.handleUserMessage(session.id, ada, 'Build the hero section')).done
    await (await services.orchestrator.handleUserMessage(session.id, ada, 'Now add a features grid')).done

    const events = await services.sessions.getEvents(session.id)
    const firstUserMessage = events.find((e) => e.type === 'user_message')!
    // fork at the very first prompt — BEFORE any commit existed
    const fork = await services.sessions.forkSession(session.id, bob, firstUserMessage.id)

    // the fork's code must be the branch's creation base (README only), not
    // the source's live HEAD which already contains both turns
    expect(fs.existsSync(path.join(fork.worktreePath, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(fork.worktreePath, 'index.html'))).toBe(false)
    const git = services.projects.gitFor(project)
    const forkLog = await git.log(fork.branchName)
    expect(forkLog.length).toBe(1) // just the initial commit
  })

  it('fork of a session with no commits starts from the branch base', async () => {
    const { services } = ctx
    const ada = await makeUser(services, 'Ada', 'ada3@fork.dev')
    const bob = await makeUser(services, 'Bob', 'bob3@fork.dev')
    const project = await services.projects.createProject('Forkly3', '', ada)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, ada)

    const fork = await services.sessions.forkSession(session.id, bob)
    const git = services.projects.gitFor(project)
    expect(await git.currentSha(fork.branchName)).toBe(await git.currentSha(session.branchName))
    expect(fs.existsSync(path.join(fork.worktreePath, 'README.md'))).toBe(true)
  })
})
