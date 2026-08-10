import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionDigest } from '@loom/shared'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext

beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

describe('F7 — session digest on end (integration, mock)', () => {
  it('stores a digest composed from the log: bullets from commits, files, counts, duration', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Dee', 'dee@digest.dev')
    const project = await services.projects.createProject('Digestible', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    await (await services.orchestrator.handleUserMessage(session.id, user, 'Build the hero section')).done
    await (await services.orchestrator.handleUserMessage(session.id, user, 'Now add a footer')).done

    await services.sessions.endSession(session.id)

    const row = await services.sessions.getSession(session.id)
    expect(row?.status).toBe('ended')
    expect(row?.digest).toBeTruthy()
    const digest = JSON.parse(row!.digest!) as SessionDigest

    expect(digest.title).toBe(session.title)
    expect(digest.commitCount).toBeGreaterThanOrEqual(2) // one commit per mock turn
    expect(digest.bullets.length).toBeGreaterThanOrEqual(1)
    expect(digest.bullets.length).toBeLessThanOrEqual(3)
    // bullets are the commit explanations (newest first)
    for (const b of digest.bullets) expect(b).toMatch(/Dee asked the agent to/)
    expect(digest.files.length).toBeGreaterThan(0)
    expect(digest.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('a session with no activity gets a minimal digest and never throws', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Nia', 'nia@digest.dev')
    const project = await services.projects.createProject('Quiet', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    await services.sessions.endSession(session.id)

    const row = await services.sessions.getSession(session.id)
    expect(row?.status).toBe('ended')
    // the session-started status note counts as an event, so a digest exists
    const digest = row?.digest ? (JSON.parse(row.digest) as SessionDigest) : null
    expect(digest).not.toBeNull()
    expect(digest!.commitCount).toBe(0)
    expect(digest!.bullets.length).toBeGreaterThanOrEqual(1)
  })
})
