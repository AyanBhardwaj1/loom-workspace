import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentToolExecution, AgentTurnContext, MergeResult, ProjectLedger } from '@loom/shared'
import { buildApp } from '../src/app'
import { SESSION_COOKIE, signValue } from '../src/auth/cookies'
import { runChecks } from '../src/checks/runChecks'
import { makeTestServices, makeUser, type TestContext } from './util'

/**
 * "Nothing reaches main that the room hasn't seen work": the verified-to-merge
 * gate, guarded agent actions, the freeze, the security checks and the ledger.
 */
let ctx: TestContext
beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

const cookieFor = async (userId: string) => ({ [SESSION_COOKIE]: signValue(await ctx.services.auth.createAuthSession(userId), ctx.config.cookieSecret) })

/** a turn that writes a page, verifies it, and proposes one test case */
const buildPage = (heading: string): AgentProvider => ({
  async *runTurn(turn: AgentTurnContext) {
    const steps: Array<[string, Record<string, unknown>]> = [
      ['write_file', { path: 'index.html', content: `<!doctype html><html lang="en"><head><title>x</title><meta name="viewport" content="width=device-width"></head><body><h1>${heading}</h1></body></html>` }],
      ['run_checks', {}],
      ['propose_tests', { cases: [{ action: 'Open the page', expect: 'It says Hi' }] }],
    ]
    for (const [name, input] of steps) {
      yield { kind: 'tool_call', name, input }
      await turn.executeTool(name, input)
    }
    yield { kind: 'message_done', fullText: 'done' }
  },
})
const buildAndPropose = buildPage('Hi')

async function team() {
  const { services } = ctx
  const ayan = await makeUser(services, 'Ayan', 'ayan@gov.dev')
  const sai = await makeUser(services, 'Sai', 'sai@gov.dev')
  const project = await services.projects.createProject('Governed', '', ayan) // owner: Ayan, gate: enforce
  await services.projects.addMemberByEmail(project.id, 'sai@gov.dev')
  const [mod] = await services.projects.listModules(project.id)
  const app = await buildApp(services)
  return { services, ayan, sai, project, moduleId: mod!.id, app }
}

describe('verified-to-merge gate', () => {
  it('blocks the driver’s own unverified merge, and opens once a teammate verifies and someone else merges', async () => {
    const w = await team()
    try {
      const session = await w.services.sessions.createSession(w.moduleId, w.sai) // Sai drives
      w.services.runtime.provider = buildAndPropose
      const t = await w.services.orchestrator.handleUserMessage(session.id, w.sai, 'Build a page')
      if (t.ok) await t.done
      const merge = async (userId: string, extra: Record<string, unknown> = {}) =>
        w.app.inject({ method: 'POST', url: `/api/projects/${w.project.id}/merge`, cookies: await cookieFor(userId), payload: { branchName: session.branchName, ...extra } })

      // the driver can't merge their own, unverified work
      const blocked = await merge(w.sai.id)
      expect(blocked.statusCode).toBe(409)
      const gate = (blocked.json() as { gate: { checks: Array<{ id: string; status: string }> } }).gate
      expect(gate.checks.find((c) => c.id === 'checks')?.status).toBe('pass') // the agent's same-turn check counts
      expect(gate.checks.find((c) => c.id === 'verified')?.status).toBe('fail')
      expect(gate.checks.find((c) => c.id === 'separation')?.status).toBe('fail')

      // the branch list shows the same gate to everyone
      const branches = (await w.app.inject({ method: 'GET', url: `/api/projects/${w.project.id}/branches`, cookies: await cookieFor(w.ayan.id) })).json() as {
        branches: Array<{ branchName: string; gate: { ok: boolean } | null }>
      }
      expect(branches.branches.find((b) => b.branchName === session.branchName)?.gate?.ok).toBe(false)

      // the driver's own pass verdict doesn't verify it; Ayan's does
      const plan = (await w.services.sessions.getEvents(session.id, 0)).find((e) => e.type === 'test_plan')!
      if (plan.type !== 'test_plan') throw new Error('no plan')
      const verdict = async (userId: string, v: 'pass' | 'fail') =>
        w.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/tests`, cookies: await cookieFor(userId), payload: { planId: plan.payload.planId, caseId: 't1', verdict: v } })
      await verdict(w.sai.id, 'pass')
      expect((await merge(w.ayan.id)).statusCode).toBe(409)
      await verdict(w.ayan.id, 'pass')

      // verified by Ayan, merged by Ayan (not the driver): allowed, with provenance in history
      const ok = await merge(w.ayan.id)
      expect(ok.statusCode).toBe(200)
      expect((ok.json() as MergeResult).merged).toBe(true)
      const [head] = await w.services.projects.gitFor(w.project).log('main', 1)
      expect(head!.subject).toMatch(/^Merge /)
      const changes = await w.services.projects.listChanges(w.project.id, { limit: 10 })
      expect(changes.some((c) => /Verified by Ayan/.test(c.plainExplanation))).toBe(true)
    } finally {
      await w.app.close()
    }
  })

  it('a verdict goes stale when a later commit moves the code under it', async () => {
    const w = await team()
    try {
      const session = await w.services.sessions.createSession(w.moduleId, w.sai)
      w.services.runtime.provider = buildAndPropose
      let t = await w.services.orchestrator.handleUserMessage(session.id, w.sai, 'Build a page')
      if (t.ok) await t.done
      const plan = (await w.services.sessions.getEvents(session.id, 0)).find((e) => e.type === 'test_plan')!
      if (plan.type !== 'test_plan') throw new Error('no plan')
      await w.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/tests`, cookies: await cookieFor(w.ayan.id), payload: { planId: plan.payload.planId, caseId: 't1', verdict: 'pass' } })
      const gateNow = async () =>
        (
          (await w.app.inject({ method: 'GET', url: `/api/projects/${w.project.id}/branches`, cookies: await cookieFor(w.ayan.id) })).json() as {
            branches: Array<{ branchName: string; gate: { ok: boolean } | null }>
          }
        ).branches.find((b) => b.branchName === session.branchName)?.gate?.ok
      expect(await gateNow()).toBe(true)
      // another turn changes the page (no new plan): the old verdict no longer counts
      w.services.runtime.provider = {
        async *runTurn(turn) {
          yield { kind: 'tool_call', name: 'write_file', input: { path: 'index.html', content: '<h1>Changed</h1>' } }
          await turn.executeTool('write_file', { path: 'index.html', content: '<h1>Changed</h1>' })
          yield { kind: 'message_done', fullText: 'changed' }
        },
      }
      t = await w.services.orchestrator.handleUserMessage(session.id, w.sai, 'Change it')
      if (t.ok) await t.done
      expect(await gateNow()).toBe(false)
    } finally {
      await w.app.close()
    }
  })

  it('only the owner can override, the reason is recorded; warn mode merges but says so', async () => {
    const w = await team()
    try {
      const session = await w.services.sessions.createSession(w.moduleId, w.ayan) // the owner drives
      w.services.runtime.provider = buildAndPropose
      const t = await w.services.orchestrator.handleUserMessage(session.id, w.ayan, 'Build a page')
      if (t.ok) await t.done
      const merge = async (userId: string, extra: Record<string, unknown> = {}) =>
        w.app.inject({ method: 'POST', url: `/api/projects/${w.project.id}/merge`, cookies: await cookieFor(userId), payload: { branchName: session.branchName, ...extra } })
      // a non-owner can't override
      expect((await merge(w.sai.id, { override: { reason: 'ship it' } })).statusCode).toBe(403)
      const forced = await merge(w.ayan.id, { override: { reason: 'demo in five minutes' } })
      expect(forced.statusCode).toBe(200)
      const changes = await w.services.projects.listChanges(w.project.id, { limit: 10 })
      expect(changes.some((c) => /without full verification: “demo in five minutes”/.test(c.plainExplanation))).toBe(true)

      // warn mode: allowed, and history says verification was incomplete
      await w.app.inject({ method: 'PUT', url: `/api/projects/${w.project.id}/policy`, cookies: await cookieFor(w.ayan.id), payload: { mergeGate: 'warn' } })
      expect((await w.app.inject({ method: 'PUT', url: `/api/projects/${w.project.id}/policy`, cookies: await cookieFor(w.sai.id), payload: { mergeGate: 'off' } })).statusCode).toBe(403)
      const s2 = await w.services.sessions.createSession(w.moduleId, w.sai)
      w.services.runtime.provider = buildPage('Another page')
      const t2 = await w.services.orchestrator.handleUserMessage(s2.id, w.sai, 'Another page')
      if (t2.ok) await t2.done
      const warned = await w.app.inject({ method: 'POST', url: `/api/projects/${w.project.id}/merge`, cookies: await cookieFor(w.sai.id), payload: { branchName: s2.branchName } })
      expect(warned.statusCode).toBe(200)
      const after = await w.services.projects.listChanges(w.project.id, { limit: 10 })
      expect(after.some((c) => /Merged before verification was complete/.test(c.plainExplanation))).toBe(true)
    } finally {
      await w.app.close()
    }
  })
})

describe('guarded actions and the freeze', () => {
  const deleting = (seen: AgentToolExecution[]): AgentProvider => ({
    async *runTurn(turn) {
      yield { kind: 'tool_call', name: 'write_file', input: { path: 'old.txt', content: 'x' } }
      seen.push(await turn.executeTool('write_file', { path: 'old.txt', content: 'x' }))
      yield { kind: 'tool_call', name: 'delete_file', input: { path: 'old.txt' } }
      seen.push(await turn.executeTool('delete_file', { path: 'old.txt' }))
      yield { kind: 'message_done', fullText: 'done' }
    },
  })

  it('a destructive call waits for a teammate; the driver can’t approve their own; approval lets it run', async () => {
    const w = await team()
    try {
      const session = await w.services.sessions.createSession(w.moduleId, w.ayan)
      const seen: AgentToolExecution[] = []
      w.services.runtime.provider = deleting(seen)
      const t = await w.services.orchestrator.handleUserMessage(session.id, w.ayan, 'Clean up')
      let request: { requestId: string } | null = null
      for (let i = 0; i < 50 && !request; i++) {
        await new Promise((r) => setTimeout(r, 50))
        const e = (await w.services.sessions.getEvents(session.id, 0)).find((x) => x.type === 'approval_request')
        if (e?.type === 'approval_request') request = e.payload
      }
      expect(request).not.toBeNull()
      expect(fs.existsSync(path.join(session.worktreePath, 'old.txt'))).toBe(true) // not yet deleted
      const decide = async (userId: string, decision: string) =>
        w.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/approvals/${request!.requestId}`, cookies: await cookieFor(userId), payload: { decision } })
      expect((await decide(w.ayan.id, 'approved')).statusCode).toBe(403)
      expect((await decide(w.sai.id, 'approved')).statusCode).toBe(200)
      expect((await decide(w.sai.id, 'denied')).statusCode).toBe(409) // decided once
      if (t.ok) await t.done
      expect(seen[1]!.ok).toBe(true)
      expect(fs.existsSync(path.join(session.worktreePath, 'old.txt'))).toBe(false)
    } finally {
      await w.app.close()
    }
  })

  it('a denial blocks the call and tells the agent not to retry', async () => {
    const w = await team()
    try {
      const session = await w.services.sessions.createSession(w.moduleId, w.ayan)
      const seen: AgentToolExecution[] = []
      w.services.runtime.provider = deleting(seen)
      const t = await w.services.orchestrator.handleUserMessage(session.id, w.ayan, 'Clean up')
      let requestId: string | null = null
      for (let i = 0; i < 50 && !requestId; i++) {
        await new Promise((r) => setTimeout(r, 50))
        const e = (await w.services.sessions.getEvents(session.id, 0)).find((x) => x.type === 'approval_request')
        if (e?.type === 'approval_request') requestId = e.payload.requestId
      }
      await w.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/approvals/${requestId}`, cookies: await cookieFor(w.sai.id), payload: { decision: 'denied' } })
      if (t.ok) await t.done
      expect(seen[1]).toMatchObject({ ok: false, summary: 'Sai denied: delete old.txt' })
      expect(seen[1]!.content).toMatch(/Don't retry/)
      expect(fs.existsSync(path.join(session.worktreePath, 'old.txt'))).toBe(true)
    } finally {
      await w.app.close()
    }
  })

  it('a frozen project refuses every write, enforced server-side; any member can freeze', async () => {
    const w = await team()
    try {
      const put = await w.app.inject({ method: 'PUT', url: `/api/projects/${w.project.id}/policy`, cookies: await cookieFor(w.sai.id), payload: { frozen: true } })
      expect(put.statusCode).toBe(200)
      const session = await w.services.sessions.createSession(w.moduleId, w.ayan)
      const seen: AgentToolExecution[] = []
      w.services.runtime.provider = deleting(seen)
      const t = await w.services.orchestrator.handleUserMessage(session.id, w.ayan, 'Write something')
      if (t.ok) await t.done
      expect(seen[0]).toMatchObject({ ok: false, summary: 'Blocked — Sai froze this project' })
      expect(fs.existsSync(path.join(session.worktreePath, 'old.txt'))).toBe(false)
    } finally {
      await w.app.close()
    }
  })

  it('a one-person project has nobody to ask — guarded calls run', async () => {
    const solo = await makeUser(ctx.services, 'Solo', 'solo@gov.dev')
    const project = await ctx.services.projects.createProject('Alone', '', solo)
    const [mod] = await ctx.services.projects.listModules(project.id)
    const session = await ctx.services.sessions.createSession(mod!.id, solo)
    const seen: AgentToolExecution[] = []
    ctx.services.runtime.provider = deleting(seen)
    const t = await ctx.services.orchestrator.handleUserMessage(session.id, solo, 'Clean up')
    if (t.ok) await t.done
    expect(seen[1]!.ok).toBe(true)
    expect((await ctx.services.sessions.getEvents(session.id, 0)).some((e) => e.type === 'approval_request')).toBe(false)
  })
})

describe('security checks', () => {
  it('fails on credentials in shipped files and environment files; warns on unlabelled fields', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sec-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><title>x</title><meta name="viewport" content="width=device-width"></head><body><input placeholder="Email"><label>Name <input></label><script src="app.js"></script></body></html>')
    fs.writeFileSync(path.join(dir, 'app.js'), `const key = "sk-ant-api03-${'a'.repeat(40)}"\n`)
    const run = await runChecks(dir, { runTests: false })
    const secrets = run.results.find((r) => r.id === 'secrets')!
    expect(secrets.status).toBe('fail')
    expect(secrets.detail).toMatch(/app\.js \(Anthropic key\)/)
    expect(secrets.detail).not.toMatch(/aaaa/) // never echoes the value
    expect(run.results.find((r) => r.id === 'form-labels')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^1 field/) })
    fs.rmSync(path.join(dir, 'app.js'))
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\n')
    expect((await runChecks(dir, { runTests: false })).results.find((r) => r.id === 'secrets')?.detail).toMatch(/\.env \(environment file\)/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('the ledger', () => {
  it('attributes spend to whoever was driving and credits every kind of contribution', async () => {
    const w = await team()
    try {
      const session = await w.services.sessions.createSession(w.moduleId, w.sai)
      w.services.runtime.provider = {
        async *runTurn() {
          yield { kind: 'usage', inputTokens: 1000, outputTokens: 200 }
          yield { kind: 'message_done', fullText: 'ok' }
        },
      }
      const t = await w.services.orchestrator.handleUserMessage(session.id, w.sai, 'Hello')
      if (t.ok) await t.done
      await w.services.sessions.addSuggestion(session.id, w.ayan, 'Try a footer')
      const ledger = (await w.app.inject({ method: 'GET', url: `/api/projects/${w.project.id}/ledger`, cookies: await cookieFor(w.ayan.id) })).json() as ProjectLedger
      expect(ledger.byMember[0]).toMatchObject({ label: 'Sai', tokens: 1200, turns: 1 })
      expect(ledger.byModule[0]!.tokens).toBe(1200)
      const sai = ledger.contributions.find((c) => c.name === 'Sai')!
      const ayan = ledger.contributions.find((c) => c.name === 'Ayan')!
      expect(sai.prompts).toBe(1)
      expect(ayan.suggestions).toBe(1)
    } finally {
      await w.app.close()
    }
  })
})
