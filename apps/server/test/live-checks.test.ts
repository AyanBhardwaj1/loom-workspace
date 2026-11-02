import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentTurnContext, ServerMessage } from '@loom/shared'
import { buildApp } from '../src/app'
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
  const driver = await makeUser(services, 'Ayan', 'ayan@checks.dev')
  const watcher = await makeUser(services, 'Sai', 'sai@checks.dev')
  const outsider = await makeUser(services, 'Eve', 'eve@checks.dev')
  const project = await services.projects.createProject('Checked', '', driver)
  await services.projects.addMemberByEmail(project.id, 'sai@checks.dev')
  const modules = await services.projects.listModules(project.id)
  const session = await services.sessions.createSession(modules[0]!.id, driver)
  return { services, driver, watcher, outsider, session }
}

const cookieFor = async (userId: string) => {
  const token = await ctx.services.auth.createAuthSession(userId)
  return { [SESSION_COOKIE]: signValue(token, ctx.config.cookieSecret) }
}

/** A provider that runs a fixed tool script, then finishes. */
function scripted(steps: Array<{ name: string; input: Record<string, unknown> }>): AgentProvider {
  return {
    async *runTurn(turn: AgentTurnContext) {
      for (const s of steps) {
        yield { kind: 'tool_call', name: s.name, input: s.input }
        await turn.executeTool(s.name, s.input)
      }
      yield { kind: 'message_done', fullText: 'done' }
    },
  }
}

describe('live checks — everyone watches the same test run', () => {
  it('any member (not just the driver) can run checks; the run is persisted and announced', async () => {
    const { services, watcher, session } = await setup()
    fs.writeFileSync(path.join(session.worktreePath, 'index.html'), '<!doctype html><html lang="en"><head><title>x</title><meta name="viewport" content="width=device-width"></head><body></body></html>')
    const live: string[] = []
    services.bus.subscribe(`session:${session.id}`, (raw) => {
      const m = raw as ServerMessage
      if (m.t === 'event') live.push(m.event.type)
    })
    const app = await buildApp(services)
    try {
      const res = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/checks`, cookies: await cookieFor(watcher.id) })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { run: { status: string } }).run.status).toBe('passed')
    } finally {
      await app.close()
    }
    expect(live).toContain('check_started')
    const events = await services.sessions.getEvents(session.id, 0)
    const run = events.find((e) => e.type === 'check_run')!
    expect(run.payload).toMatchObject({ trigger: 'manual', byName: 'Sai', status: 'passed' })
    expect(events.some((e) => e.type === 'check_started')).toBe(false)
  })

  it('refuses non-members', async () => {
    const { services, outsider, session } = await setup()
    const app = await buildApp(services)
    try {
      const res = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/checks`, cookies: await cookieFor(outsider.id) })
      expect(res.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('runs static checks automatically after a commit', async () => {
    const { services, driver, session } = await setup()
    services.runtime.provider = scripted([{ name: 'write_file', input: { path: 'index.html', content: '<h1>hi</h1>' } }])
    await (await services.orchestrator.handleUserMessage(session.id, driver, 'make a page')).done
    const events = await services.sessions.getEvents(session.id, 0)
    const types = events.map((e) => e.type)
    expect(types.indexOf('check_run')).toBeGreaterThan(types.indexOf('commit'))
    const run = events.find((e) => e.type === 'check_run')!
    expect(run.payload).toMatchObject({ trigger: 'commit' })
    // the page has no doctype/title/lang: page basics warn
    expect((run.payload as { status: string }).status).toBe('warned')
  })

  it('the agent can test its own work: run_checks returns a summary and records the run', async () => {
    const { services, driver, session } = await setup()
    services.runtime.provider = scripted([
      { name: 'write_file', input: { path: 'index.html', content: '<!doctype html><html lang="en"><head><title>t</title><meta name="viewport" content="x"></head><body><img src="gone.png" alt="x"></body></html>' } },
      { name: 'run_checks', input: {} },
    ])
    await (await services.orchestrator.handleUserMessage(session.id, driver, 'build and verify')).done
    const events = await services.sessions.getEvents(session.id, 0)
    const result = events.find((e) => e.type === 'tool_result' && (e.payload as { toolName: string }).toolName === 'run_checks')!
    expect((result.payload as { summary: string }).summary).toMatch(/check/i)
    const runs = events.filter((e) => e.type === 'check_run')
    expect(runs[0]!.payload).toMatchObject({ trigger: 'agent', status: 'failed' })
    // the agent already verified this turn — no duplicate automatic run after the commit
    expect(runs).toHaveLength(1)
  })

  it('update_plan broadcasts the agent plan as a persisted event', async () => {
    const { services, driver, session } = await setup()
    services.runtime.provider = scripted([
      { name: 'update_plan', input: { steps: [{ text: 'Write the hero', status: 'doing' }, { text: 'Add the form', status: 'todo' }] } },
    ])
    await (await services.orchestrator.handleUserMessage(session.id, driver, 'plan it')).done
    const plan = (await services.sessions.getEvents(session.id, 0)).find((e) => e.type === 'plan')!
    expect(plan.payload).toEqual({ steps: [{ text: 'Write the hero', status: 'doing' }, { text: 'Add the form', status: 'todo' }] })
  })
})
