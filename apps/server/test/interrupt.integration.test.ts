import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext

afterEach(async () => {
  await ctx.cleanup()
})

describe('interrupt (stop) — orchestrator', () => {
  it('stops the in-flight turn, commits partial work, and marks it "Stopped by driver"', async () => {
    ctx = await makeTestServices({ fastMock: false }) // slow enough to interrupt
    const { services } = ctx
    const user = await makeUser(services, 'Ada', 'ada@stop.dev')
    const project = await services.projects.createProject('Stoppable', '', user)
    const modules = await services.projects.listModules(project.id)
    const landing = modules.find((m) => m.name === 'Landing page')!
    const session = await services.sessions.createSession(landing.id, user)

    const turn = await services.orchestrator.handleUserMessage(session.id, user, 'Build the hero section')
    expect(turn.ok).toBe(true)
    expect(services.orchestrator.isBusy(session.id)).toBe(true)

    // interrupt shortly after it starts
    await new Promise((r) => setTimeout(r, 60))
    const stop = await services.orchestrator.stopTurn(session.id, user)
    expect(stop.ok).toBe(true)

    await turn.done

    const events = await services.sessions.getEvents(session.id)
    const lastStatus = [...events].reverse().find((e) => e.type === 'status')!
    expect(lastStatus.type === 'status' && lastStatus.payload.note).toBe('Stopped by driver')

    // the session is released, not stuck busy
    expect(services.orchestrator.isBusy(session.id)).toBe(false)
    expect((await services.sessions.getSession(session.id))!.status).toBe('idle')

    // no tool_call was left without its result (pairing preserved across a stop)
    const calls = events.filter((e) => e.type === 'tool_call').length
    const results = events.filter((e) => e.type === 'tool_result').length
    expect(results).toBe(calls)

    // and the driver can immediately continue
    const again = await services.orchestrator.handleUserMessage(session.id, user, 'now add a footer')
    expect(again.ok).toBe(true)
    await again.done
  })

  it('guards stop: only the driver, and only while a turn is running', async () => {
    ctx = await makeTestServices() // fast mock
    const { services } = ctx
    const ada = await makeUser(services, 'Ada', 'ada2@stop.dev')
    const bob = await makeUser(services, 'Bob', 'bob2@stop.dev')
    const project = await services.projects.createProject('Stoppable2', '', ada)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, ada)

    // nothing running → error
    const idle = await services.orchestrator.stopTurn(session.id, ada)
    expect(idle.ok).toBe(false)
    expect(idle.error).toMatch(/not working/i)

    // non-driver cannot stop
    const notDriver = await services.orchestrator.stopTurn(session.id, bob)
    expect(notDriver.ok).toBe(false)
    expect(notDriver.error).toMatch(/driver/i)
  })
})
