import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parseClientMessage, type ServerMessage } from '@loom/shared'
import { startServer, type RunningServer } from '../src/app'
import { makeTestServices, type TestContext } from './util'
import { mintPreviewToken, readPreviewToken } from '../src/routes/preview'

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

async function signup(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password-123' }),
  })
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]!, id: ((await res.json()) as { user: { id: string } }).user.id }
}
async function api<T>(cookie: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
  return (await res.json()) as T
}
function connect(cookie: string): Promise<{ ws: WebSocket; messages: ServerMessage[]; send: (m: unknown) => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie } })
    const messages: ServerMessage[] = []
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as ServerMessage))
    ws.on('open', () => resolve({ ws, messages, send: (m) => ws.send(JSON.stringify(m)) }))
    ws.on('error', reject)
  })
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

async function world() {
  const ayan = await signup('Ayan', 'ayan@pp.dev')
  const sai = await signup('Sai', 'sai@pp.dev')
  const eve = await signup('Eve', 'eve@pp.dev')
  const { project } = await api<{ project: { id: string } }>(ayan.cookie, 'POST', '/api/projects', { name: 'Presence', description: '' })
  await api(ayan.cookie, 'POST', `/api/projects/${project.id}/members`, { email: 'sai@pp.dev' })
  const detail = await api<{ modules: Array<{ id: string }> }>(ayan.cookie, 'GET', `/api/projects/${project.id}`)
  const { session } = await api<{ session: { id: string } }>(ayan.cookie, 'POST', `/api/modules/${detail.modules[0]!.id}/sessions`, {})
  return { ayan, sai, eve, session }
}

describe('preview presence protocol', () => {
  it('accepts well-formed frames and rejects malformed or oversized ones', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'preview_presence', sessionId: 's', kind: 'move', x: 10, y: 900, path: '/' }))).toMatchObject({ kind: 'move' })
    expect(parseClientMessage(JSON.stringify({ t: 'preview_presence', sessionId: 's', kind: 'click', x: 1, y: 2, label: 'Join waitlist' }))).toMatchObject({ label: 'Join waitlist' })
    expect(parseClientMessage(JSON.stringify({ t: 'preview_presence', sessionId: 's', kind: 'teleport' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'preview_presence', sessionId: 's', kind: 'nav', path: 'x'.repeat(5000) }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ t: 'preview_presence', sessionId: 's', kind: 'move', x: -5, y: 1 }))).toBeNull()
  })
})

describe('preview presence relay (integration)', () => {
  it('relays a member’s cursor and clicks to teammates, stamped with the SERVER’s identity', async () => {
    const { ayan, sai, session } = await world()
    const a = await connect(ayan.cookie)
    const s = await connect(sai.cookie)
    a.send({ t: 'sub', sessionId: session.id })
    s.send({ t: 'sub', sessionId: session.id })
    await settle()
    s.send({ t: 'preview_presence', sessionId: session.id, kind: 'click', x: 120, y: 340, path: '/', label: 'Join waitlist' })
    await settle(400)
    const got = a.messages.find((m) => m.t === 'preview_presence')
    expect(got).toMatchObject({ t: 'preview_presence', sessionId: session.id, kind: 'click', userId: sai.id, name: 'Sai', label: 'Join waitlist' })
    a.ws.close()
    s.ws.close()
  })

  it('ignores non-members and throttles floods', async () => {
    const { ayan, eve, session } = await world()
    const a = await connect(ayan.cookie)
    const e = await connect(eve.cookie)
    a.send({ t: 'sub', sessionId: session.id })
    await settle()
    e.send({ t: 'preview_presence', sessionId: session.id, kind: 'move', x: 1, y: 1 })
    await settle(300)
    expect(a.messages.filter((m) => m.t === 'preview_presence')).toHaveLength(0)

    const s2 = await connect(ayan.cookie)
    for (let i = 0; i < 100; i++) s2.send({ t: 'preview_presence', sessionId: session.id, kind: 'move', x: i, y: i })
    await settle(500)
    const relayed = a.messages.filter((m) => m.t === 'preview_presence').length
    expect(relayed).toBeGreaterThan(0)
    expect(relayed).toBeLessThanOrEqual(30)
    a.ws.close()
    e.ws.close()
    s2.ws.close()
  })
})

describe('preview bridge injection', () => {
  it('injects the presence bridge into HTML pages only, and serves the bridge script', async () => {
    const { ayan, session } = await world()
    const s = await ctx.services.sessions.getSession(session.id)
    fs.writeFileSync(path.join(s!.worktreePath, 'index.html'), '<!doctype html><html><body><h1>hi</h1></body></html>')
    fs.writeFileSync(path.join(s!.worktreePath, 'data.json'), '{"a":1}')

    const html = await (await fetch(`${base}/preview/session/${session.id}/`, { headers: { cookie: ayan.cookie } })).text()
    expect(html).toContain('<h1>hi</h1>')
    expect(html).toMatch(/<script src="\/preview-kit\/bridge\.js" defer><\/script>\s*<\/body>/)

    const json = await (await fetch(`${base}/preview/session/${session.id}/data.json`, { headers: { cookie: ayan.cookie } })).text()
    expect(json).toBe('{"a":1}')

    const bridge = await fetch(`${base}/preview-kit/bridge.js`)
    expect(bridge.status).toBe(200)
    expect(bridge.headers.get('content-type')).toMatch(/javascript/)
    const src = await bridge.text()
    expect(src).toContain('postMessage')
    // never reads what people type
    expect(src).not.toMatch(/\.value\b/)
  })
})

describe('signed preview URLs (the sandboxed frame sends no cookies)', () => {
  it('serves a session’s assets with NO cookie through the signed path, and refuses everyone else', async () => {
    const { ayan, eve, session } = await world()
    const s = await ctx.services.sessions.getSession(session.id)
    fs.writeFileSync(path.join(s!.worktreePath, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body>hi</body></html>')
    fs.writeFileSync(path.join(s!.worktreePath, 'styles.css'), 'body{color:red}')

    const minted = await fetch(`${base}/api/preview-url?session=${session.id}`, { headers: { cookie: ayan.cookie } })
    expect(minted.status).toBe(200)
    const { url } = (await minted.json()) as { url: string }
    expect(url).toMatch(/^\/preview\/t\/[^/]+\/$/)

    // exactly what the sandboxed frame does: no cookie at all
    const css = await fetch(`${base}${url}styles.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toMatch(/text\/css/)
    expect(await css.text()).toBe('body{color:red}')
    const html = await fetch(`${base}${url}`)
    expect(await html.text()).toContain('/preview-kit/bridge.js')
    expect(html.headers.get('content-security-policy')).toContain('sandbox allow-scripts')

    // non-members cannot mint one
    expect((await fetch(`${base}/api/preview-url?session=${session.id}`, { headers: { cookie: eve.cookie } })).status).toBe(403)
    // tampering breaks the signature
    const token = url.split('/')[3]!
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA')
    expect((await fetch(`${base}/preview/t/${forged}/styles.css`)).status).toBe(403)
    // a session cookie value is never a valid preview token (domain-separated)
    const cookieVal = decodeURIComponent(ayan.cookie.split('=')[1]!)
    expect((await fetch(`${base}/preview/t/${encodeURIComponent(cookieVal)}/`)).status).toBe(403)
  })

  it('expires, and is bound to the user’s current membership', async () => {
    const secret = 'test-secret'
    const t = mintPreviewToken({ k: 's', i: 'S1', u: 'U1' }, secret, 1_000)
    expect(readPreviewToken(t, secret, 2_000)).toMatchObject({ k: 's', i: 'S1', u: 'U1' })
    expect(readPreviewToken(t, secret, 1_000 + 8 * 60 * 60 * 1000 + 1)).toBeNull()
    expect(readPreviewToken(t, 'other-secret', 2_000)).toBeNull()

    // a minted link stops working once the holder is no longer a member
    const { sai, session } = await world()
    const { url } = (await (await fetch(`${base}/api/preview-url?session=${session.id}`, { headers: { cookie: sai.cookie } })).json()) as { url: string }
    expect((await fetch(`${base}${url}`)).status).toBe(200)
    // (membership is re-checked per request; simulate the removal at the service)
    const spy = vi.spyOn(ctx.services.projects, 'isMember').mockResolvedValue(false)
    expect((await fetch(`${base}${url}`)).status).toBe(403)
    spy.mockRestore()
  })
})
