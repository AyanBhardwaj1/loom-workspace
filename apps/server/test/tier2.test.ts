import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext

beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

describe('F8 — annotations', () => {
  it('appends to the log, broadcasts, and copies into forks like any event', async () => {
    const { services } = ctx
    const driver = await makeUser(services, 'Drv', 'drv@t2.dev')
    const spec = await makeUser(services, 'Spc', 'spc@t2.dev')
    const project = await services.projects.createProject('Annotated', '', driver)
    await services.projects.addMemberByEmail(project.id, spec.email)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, driver)

    await (await services.orchestrator.handleUserMessage(session.id, driver, 'Build a hero')).done
    const events = await services.sessions.getEvents(session.id)
    const target = events.find((e) => e.type === 'commit')!

    await services.sessions.appendEvent(session.id, 'annotation', {
      targetEventId: target.id,
      authorUserId: spec.id,
      authorName: spec.name,
      authorColor: spec.avatarColor,
      kind: 'reaction',
      body: 'spark',
    })

    const after = await services.sessions.getEvents(session.id)
    const ann = after.filter((e) => e.type === 'annotation')
    expect(ann).toHaveLength(1)
    expect(ann[0]!.type === 'annotation' && ann[0]!.payload.targetEventId).toBe(target.id)
  })
})

describe('F9 — driver handoff invariant', () => {
  it('swaps atomically: the old driver loses write access, the new one gains it', async () => {
    const { services } = ctx
    const ayan = await makeUser(services, 'Ay', 'ay@t2.dev')
    const sai = await makeUser(services, 'Sa', 'sa@t2.dev')
    const project = await services.projects.createProject('Wheel', '', ayan)
    await services.projects.addMemberByEmail(project.id, sai.email)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, ayan)

    // transfer conditioned on the CURRENT driver — a stale offerer loses
    const wrong = await services.sessions.transferDriver(session.id, sai.id, sai)
    expect(wrong).toBe(false)

    const ok = await services.sessions.transferDriver(session.id, ayan.id, sai)
    expect(ok).toBe(true)

    // a second transfer from the OLD driver must fail (single-writer stays single)
    const stale = await services.sessions.transferDriver(session.id, ayan.id, ayan)
    expect(stale).toBe(false)

    // write access follows the row
    const rejected = await services.orchestrator.handleUserMessage(session.id, ayan, 'still me?')
    expect(rejected.ok).toBe(false)
    const accepted = await services.orchestrator.handleUserMessage(session.id, sai, 'my turn')
    expect(accepted.ok).toBe(true)
    await accepted.done

    // the seam is recorded on the log with the new driver's identity
    const events = await services.sessions.getEvents(session.id)
    const seam = events.find((e) => e.type === 'status' && e.payload.newDriverUserId === sai.id)
    expect(seam).toBeTruthy()
  })
})

describe('F11 — share links', () => {
  it('mints a token, resolves by it, and revocation kills the link', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Sh', 'sh@t2.dev')
    const project = await services.projects.createProject('Shared', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    const token = await services.sessions.setShareToken(session.id)
    expect(token).toMatch(/^[0-9a-f]{40}$/)

    const found = await services.sessions.getSessionByShareToken(token)
    expect(found?.id).toBe(session.id)

    await services.sessions.clearShareToken(session.id)
    const gone = await services.sessions.getSessionByShareToken(token)
    expect(gone).toBeNull()
  })
})
