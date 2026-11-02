import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentToolExecution, AgentTurnContext } from '@loom/shared'
import { buildApp } from '../src/app'
import { foldTranscript } from '../src/agent/context'
import { MockAgentProvider } from '../src/agent/providers/mock'
import { SESSION_COOKIE, signValue } from '../src/auth/cookies'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext
beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

async function setup() {
  const { services } = ctx
  const driver = await makeUser(services, 'Ayan', 'ayan@steer.dev')
  const watcher = await makeUser(services, 'Sai', 'sai@steer.dev')
  const outsider = await makeUser(services, 'Eve', 'eve@steer.dev')
  const project = await services.projects.createProject('Steered', '', driver)
  await services.projects.addMemberByEmail(project.id, 'sai@steer.dev')
  const modules = await services.projects.listModules(project.id)
  const session = await services.sessions.createSession(modules[0]!.id, driver)
  return { services, driver, watcher, outsider, session }
}

const cookieFor = async (userId: string) => {
  const token = await ctx.services.auth.createAuthSession(userId)
  return { [SESSION_COOKIE]: signValue(token, ctx.config.cookieSecret) }
}

/**
 * Two tool calls with a gate between them, recording what the model would
 * see in each tool result — so a test can steer while the turn is mid-flight.
 */
function gated() {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let reachedGate!: () => void
  const atGate = new Promise<void>((r) => (reachedGate = r))
  const seen: AgentToolExecution[] = []
  const requests: string[] = []
  const provider: AgentProvider = {
    async *runTurn(turn: AgentTurnContext) {
      requests.push(turn.userMessage)
      if (requests.length > 1) {
        yield { kind: 'message_done', fullText: 'follow-up' }
        return
      }
      yield { kind: 'tool_call', name: 'list_files', input: {} }
      reachedGate()
      await gate
      seen.push(await turn.executeTool('list_files', {}))
      yield { kind: 'tool_call', name: 'list_files', input: {} }
      seen.push(await turn.executeTool('list_files', {}))
      yield { kind: 'message_done', fullText: 'done' }
    },
  }
  return { provider, release, atGate, seen, requests }
}

describe('mid-run steering — delivered at the next tool boundary', () => {
  it('records the steer at once, hands it to the agent after the running tool, and marks it applied', async () => {
    const { services, driver, session } = await setup()
    const g = gated()
    services.runtime.provider = g.provider
    const started = await services.orchestrator.handleUserMessage(session.id, driver, 'Build the landing page')
    expect(started.ok).toBe(true)
    await g.atGate

    const res = await services.orchestrator.steer(session.id, driver, 'Use a dark theme instead')
    expect(res.ok).toBe(true)
    // the whole room sees the steer immediately, before the agent gets it
    let events = await services.sessions.getEvents(session.id, 0)
    expect(events.find((e) => e.type === 'steer')?.payload).toMatchObject({ text: 'Use a dark theme instead', byName: 'Ayan' })
    expect(events.some((e) => e.type === 'steer_applied')).toBe(false)

    g.release()
    if (started.ok) await started.done
    // exactly one tool result carried it, and it asks for an acknowledgement
    const carriers = g.seen.filter((x) => x.content?.includes('[STEERING'))
    expect(carriers).toHaveLength(1)
    expect(carriers[0]!.content).toContain('Ayan: Use a dark theme instead')
    expect(carriers[0]!.content).toMatch(/say in one sentence how you read it/)
    events = await services.sessions.getEvents(session.id, 0)
    expect(events.find((e) => e.type === 'steer_applied')?.payload).toMatchObject({ afterTool: 'list_files' })
    // delivered in-turn → not repeated as a follow-up turn
    expect(g.requests).toEqual(['Build the landing page'])
  })

  it('a steer that never met a tool boundary becomes the next turn', async () => {
    const { services, driver, session } = await setup()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reached!: () => void
    const atGate = new Promise<void>((r) => (reached = r))
    const requests: string[] = []
    services.runtime.provider = {
      async *runTurn(turn: AgentTurnContext) {
        requests.push(turn.userMessage)
        if (requests.length === 1) {
          reached()
          await gate
        }
        yield { kind: 'message_done', fullText: `answered: ${turn.userMessage}` }
      },
    }
    const started = await services.orchestrator.handleUserMessage(session.id, driver, 'Explain the layout')
    await atGate
    expect((await services.orchestrator.steer(session.id, driver, 'Also cover the footer')).ok).toBe(true)
    release()
    if (started.ok) await started.done
    expect(requests).toEqual(['Explain the layout', 'Also cover the footer'])
    const events = await services.sessions.getEvents(session.id, 0)
    expect(events.find((e) => e.type === 'steer_applied')?.payload).toMatchObject({ afterTool: null })
  })

  it('only the driver may steer, and only while the agent is working', async () => {
    const { services, driver, watcher, session } = await setup()
    expect((await services.orchestrator.steer(session.id, driver, 'x')).error).toMatch(/not working/)
    const g = gated()
    services.runtime.provider = g.provider
    const started = await services.orchestrator.handleUserMessage(session.id, driver, 'go')
    await g.atGate
    expect((await services.orchestrator.steer(session.id, watcher, 'take over')).error).toMatch(/Only the driver/)
    g.release()
    if (started.ok) await started.done
  })

  it('steers are part of the agent’s memory on later turns', () => {
    const t = foldTranscript([], [
      { id: '1', sessionId: 's', seq: 1, createdAt: '', type: 'steer', payload: { steerId: 'a', text: 'dark theme', byUserId: 'u', byName: 'Ayan' } },
    ])
    expect(t[0]).toMatchObject({ role: 'user', text: '(while you were working) dark theme' })
  })

  it('the keyless mock acknowledges a steer out loud', async () => {
    const { services, driver, session } = await setup()
    services.runtime.provider = new MockAgentProvider({ fast: true })
    const started = await services.orchestrator.handleUserMessage(session.id, driver, 'Build a landing page with a hero and a waitlist form')
    // steer as soon as the turn is running (the mock's first tool is update_plan)
    await new Promise((r) => setTimeout(r, 5))
    await services.orchestrator.steer(session.id, driver, 'Make the headline shorter')
    if (started.ok) await started.done
    const events = await services.sessions.getEvents(session.id, 0)
    const said = events.filter((e) => e.type === 'assistant_message').map((e) => (e.type === 'assistant_message' ? e.payload.text : '')).join(' ')
    expect(said).toMatch(/Got it — Ayan wants “Make the headline shorter”/)
  })
})

describe('team test cases — the agent proposes, teammates verify in the live preview', () => {
  it('propose_tests persists a test plan; any member records a verdict; the agent reads failures next turn', async () => {
    const { services, driver, watcher, outsider, session } = await setup()
    services.runtime.provider = {
      async *runTurn(turn: AgentTurnContext) {
        const cases = [
          { action: 'Submit the waitlist form empty', expect: 'It asks for an email' },
          { action: 'Submit a valid email', expect: 'A thank-you message appears' },
        ]
        yield { kind: 'tool_call', name: 'propose_tests', input: { cases } }
        await turn.executeTool('propose_tests', { cases })
        yield { kind: 'message_done', fullText: 'Please try these.' }
      },
    }
    const started = await services.orchestrator.handleUserMessage(session.id, driver, 'Add a waitlist form')
    if (started.ok) await started.done
    const plan = (await services.sessions.getEvents(session.id, 0)).find((e) => e.type === 'test_plan')
    expect(plan?.type).toBe('test_plan')
    if (plan?.type !== 'test_plan') return
    expect(plan.payload.cases.map((c) => c.id)).toEqual(['t1', 't2'])

    const app = await buildApp(services)
    try {
      const post = async (userId: string, body: unknown) =>
        app.inject({ method: 'POST', url: `/api/sessions/${session.id}/tests`, cookies: await cookieFor(userId), payload: body as object })
      const ok = await post(watcher.id, { planId: plan.payload.planId, caseId: 't1', verdict: 'fail', note: 'No error shown' })
      expect(ok.statusCode).toBe(200)
      // a double-click is not a second event
      await post(watcher.id, { planId: plan.payload.planId, caseId: 't1', verdict: 'fail', note: 'No error shown' })
      expect((await post(driver.id, { planId: plan.payload.planId, caseId: 't2', verdict: 'pass' })).statusCode).toBe(200)
      expect((await post(outsider.id, { planId: plan.payload.planId, caseId: 't1', verdict: 'pass' })).statusCode).toBe(403)
      expect((await post(watcher.id, { planId: plan.payload.planId, caseId: 't9', verdict: 'pass' })).statusCode).toBe(404)
      expect((await post(watcher.id, { planId: plan.payload.planId, caseId: 't1', verdict: 'maybe' })).statusCode).toBe(400)
    } finally {
      await app.close()
    }

    const events = await services.sessions.getEvents(session.id, 0)
    const verdicts = events.filter((e) => e.type === 'test_verdict')
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]!.payload).toMatchObject({ caseId: 't1', verdict: 'fail', byName: 'Sai', note: 'No error shown' })

    // the next turn's transcript carries the team's evidence
    let transcript: AgentTurnContext['transcript'] = []
    services.runtime.provider = {
      async *runTurn(turn: AgentTurnContext) {
        transcript = turn.transcript
        yield { kind: 'message_done', fullText: 'fixing' }
      },
    }
    const next = await services.orchestrator.handleUserMessage(session.id, driver, 'Fix what failed')
    if (next.ok) await next.done
    expect(transcript.map((t) => t.text)).toContain('Sai tested [t1]: FAIL — No error shown')
    expect(transcript.some((t) => t.text.startsWith('proposed tests: [t1] Submit the waitlist form empty'))).toBe(true)
  })
})
