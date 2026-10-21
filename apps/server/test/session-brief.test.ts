import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentTurnContext, SessionEvent } from '@loom/shared'
import { agentDynamicContext, BRIEF_COMMITS, foldBrief } from '../src/agent/context'
import { makeTestServices, makeUser, type TestContext } from './util'

let seq = 0
function ev(type: string, payload: Record<string, unknown>): SessionEvent {
  seq += 1
  return { id: `e${seq}`, sessionId: 's', seq, createdAt: '2026-10-21T00:00:00Z', type, payload } as SessionEvent
}
const ask = (text: string) => ev('user_message', { text })
const commit = (technicalSummary: string) =>
  ev('commit', { changeId: 'c', commitSha: 'abc', technicalSummary, plainExplanation: technicalSummary })

describe('foldBrief — the session memory that never trims away the goal', () => {
  it('keeps the FIRST request as the goal and every commit in order', () => {
    const brief = foldBrief(null, [ask('Build a landing page'), commit('Add hero'), ask('Add pricing'), commit('Add pricing table')])
    expect(brief.goal).toBe('Build a landing page')
    expect(brief.commits).toEqual(['Add hero', 'Add pricing table'])
  })

  it('is suffix-associative, like the transcript fold (snapshot integrity)', () => {
    const all = [ask('Goal'), ...Array.from({ length: BRIEF_COMMITS + 10 }, (_, i) => commit(`c${i}`))]
    for (const cut of [0, 1, 5, all.length]) {
      expect(foldBrief(foldBrief(null, all.slice(0, cut)), all.slice(cut))).toEqual(foldBrief(null, all))
    }
    // bounded: only the most recent commits are kept
    expect(foldBrief(null, all).commits).toHaveLength(BRIEF_COMMITS)
    expect(foldBrief(null, all).commits.at(-1)).toBe(`c${BRIEF_COMMITS + 9}`)
  })

  it('renders into the per-turn context alongside the file tree', () => {
    const text = agentDynamicContext({ fileTree: ['index.html'], brief: { goal: 'Build a landing page', commits: ['Add hero'] } })
    expect(text).toContain('Build a landing page')
    expect(text).toContain('- Add hero')
    expect(text).toContain('- index.html')
  })
})

let ctx: TestContext
beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

describe('orchestrator — the brief reaches the provider every turn', () => {
  it('passes the original goal on later turns', async () => {
    const { services } = ctx
    const user = await makeUser(services, 'Ayan', 'ayan@brief.dev')
    const project = await services.projects.createProject('Brief', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    const seen: AgentTurnContext[] = []
    const capture: AgentProvider = {
      async *runTurn(turn) {
        seen.push(turn)
        yield { kind: 'message_done', fullText: 'ok' }
      },
    }
    services.runtime.provider = capture
    for (const text of ['Build a waitlist landing page', 'Make the button bigger', 'Now add a footer']) {
      await (await services.orchestrator.handleUserMessage(session.id, user, text)).done
    }
    expect(seen.map((t) => t.brief?.goal)).toEqual([
      'Build a waitlist landing page',
      'Build a waitlist landing page',
      'Build a waitlist landing page',
    ])
  })
})
