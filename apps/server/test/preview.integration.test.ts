import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src/app'
import { makeTestServices, type TestContext } from './util'

let ctx: TestContext
let server: RunningServer
let base: string

beforeEach(async () => {
  ctx = await makeTestServices()
  server = await startServer(ctx.services, 0)
  base = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  await server.stop()
  await ctx.cleanup()
})

async function signup(name: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password-123' }),
  })
  return res.headers.get('set-cookie')!.split(';')[0]!
}

async function userByEmail(email: string) {
  const user = await ctx.services.auth.login(email, 'password-123')
  if (!user) throw new Error('login failed in test setup')
  return user
}

describe('preview route (integration)', () => {
  it('serves a project workspace safely and blocks every escape', async () => {
    const cookie = await signup('Ada', 'ada@preview.dev')
    const { services } = ctx
    const user = await userByEmail('ada@preview.dev')
    const project = await services.projects.createProject('Prev', '', user)

    // main preview: README exists but no index.html → generated directory index
    const root = await fetch(`${base}/preview/main/${project.id}/`, { headers: { cookie } })
    expect(root.status).toBe(200)
    expect(root.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(root.headers.get('x-content-type-options')).toBe('nosniff')
    const rootHtml = await root.text()
    expect(rootHtml.toLowerCase()).toContain('readme.md')

    // a real file is served with the right content-type
    const readme = await fetch(`${base}/preview/main/${project.id}/README.md`, { headers: { cookie } })
    expect(readme.status).toBe(200)
    expect(readme.headers.get('content-type')).toContain('text/plain')

    // --- escapes: two layers of defense ---
    // (a) literal ../ is collapsed by URL normalization before it reaches the
    //     route, so it can never even name an outside file; only property that
    //     matters is that no outside content leaks.
    const normalizedAway = await fetch(`${base}/preview/main/${project.id}/../../../../etc/passwd`, {
      headers: { cookie },
    })
    expect(await normalizedAway.text()).not.toContain('root:')
    // (b) percent-encoded traversal DOES reach our resolver — must be rejected.
    for (const evil of ['..%2f..%2f..%2fetc%2fpasswd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
      const res = await fetch(`${base}/preview/main/${project.id}/${evil}`, { headers: { cookie } })
      expect([403, 404]).toContain(res.status)
      expect(await res.text()).not.toContain('root:')
    }

    // .git is off-limits (both forms)
    for (const gitPath of ['.git/config', '.git/HEAD']) {
      const res = await fetch(`${base}/preview/main/${project.id}/${gitPath}`, { headers: { cookie } })
      expect([403, 404]).toContain(res.status)
    }

    // unauthenticated → 401
    const anon = await fetch(`${base}/preview/main/${project.id}/`)
    expect(anon.status).toBe(401)

    // non-member → 403
    const outsider = await signup('Mallory', 'mallory@preview.dev')
    const forbidden = await fetch(`${base}/preview/main/${project.id}/`, { headers: { cookie: outsider } })
    expect(forbidden.status).toBe(403)
  })

  it('serves a session worktree and renders index.html when present', async () => {
    const cookie = await signup('Ada', 'ada2@preview.dev')
    const { services } = ctx
    const user = await userByEmail('ada2@preview.dev')
    const project = await services.projects.createProject('Prev2', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    // write an index.html directly into the worktree
    fs.writeFileSync(path.join(session.worktreePath, 'index.html'), '<h1>hello preview</h1>')

    const res = await fetch(`${base}/preview/session/${session.id}/`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('hello preview')

    // unknown session → 404
    const missing = await fetch(`${base}/preview/session/does-not-exist/`, { headers: { cookie } })
    expect(missing.status).toBe(404)
  })

  it('refuses to serve through a symlink that escapes the worktree', async () => {
    const cookie = await signup('Ada', 'ada3@preview.dev')
    const { services } = ctx
    const user = await userByEmail('ada3@preview.dev')
    const project = await services.projects.createProject('Prev3', '', user)
    const modules = await services.projects.listModules(project.id)
    const session = await services.sessions.createSession(modules[0]!.id, user)

    // a secret outside the worktree, and a symlink to it the agent could plant
    const secret = path.join(os.tmpdir(), `loom-secret-${Date.now()}.txt`)
    fs.writeFileSync(secret, 'TOP-SECRET-PREVIEW-LEAK')
    fs.symlinkSync(secret, path.join(session.worktreePath, 'leak.txt'))
    // and a symlinked directory pointing at a real dir outside
    fs.symlinkSync(os.tmpdir(), path.join(session.worktreePath, 'out'))

    try {
      const viaFile = await fetch(`${base}/preview/session/${session.id}/leak.txt`, { headers: { cookie } })
      expect([403, 404]).toContain(viaFile.status)
      expect(await viaFile.text()).not.toContain('TOP-SECRET-PREVIEW-LEAK')

      const viaDir = await fetch(`${base}/preview/session/${session.id}/out/${path.basename(secret)}`, {
        headers: { cookie },
      })
      expect([403, 404]).toContain(viaDir.status)
      expect(await viaDir.text()).not.toContain('TOP-SECRET-PREVIEW-LEAK')
    } finally {
      fs.rmSync(secret, { force: true })
    }
  })

  it('serves preview with a sandbox CSP that neutralizes a direct (new-tab) open', async () => {
    const cookie = await signup('Ada', 'ada4@preview.dev')
    const { services } = ctx
    const user = await userByEmail('ada4@preview.dev')
    const project = await services.projects.createProject('Prev4', '', user)
    const res = await fetch(`${base}/preview/main/${project.id}/`, { headers: { cookie } })
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain('sandbox allow-scripts') // opaque origin even on top-level nav
    expect(csp).toContain("connect-src 'none'")
  })
})
