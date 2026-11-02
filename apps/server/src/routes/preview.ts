import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Services } from '../services'
import { BRIDGE_JS } from '../preview/bridge'
import { signValue, unsignValue } from '../auth/cookies'
import { makeRequireUser } from './helpers'

/**
 * Signed preview URLs. The iframe is sandboxed (opaque origin), so the
 * browser treats every subresource request it makes — styles.css, app.js,
 * images — as cross-site and never attaches our SameSite=Lax cookie. With
 * cookie auth alone the document loads and every asset 401s (Chrome then
 * blocks them as ORB). A short-lived capability in the PATH fixes that:
 * relative URLs inherit it, and it names exactly one user + one workspace.
 * Membership is still re-checked on every request, so removing someone from
 * a project revokes their links immediately.
 */
const PREVIEW_TOKEN_TTL_MS = 8 * 60 * 60 * 1000
type PreviewGrant = { k: 's' | 'm' | 'l'; i: string; u: string; e: number }

export function mintPreviewToken(grant: Omit<PreviewGrant, 'e'>, secret: string, now = Date.now()): string {
  const body = Buffer.from([grant.k, grant.i, grant.u, (now + PREVIEW_TOKEN_TTL_MS).toString(36)].join('~')).toString('base64url')
  // domain-separated from session cookies: a cookie value can never verify as a preview token
  return signValue(`pv1.${body}`, secret)
}

export function readPreviewToken(token: string, secret: string, now = Date.now()): PreviewGrant | null {
  const raw = unsignValue(token, secret)
  if (!raw || !raw.startsWith('pv1.')) return null
  const [k, i, u, exp, extra] = Buffer.from(raw.slice(4), 'base64url').toString('utf8').split('~')
  if ((k !== 's' && k !== 'm' && k !== 'l') || !i || !u || !exp || extra !== undefined) return null
  const e = parseInt(exp, 36)
  return Number.isFinite(e) && e > now ? { k, i, u, e } : null
}

/**
 * Live preview of what a session (or merged main) has built. The worktree
 * holds real, agent-generated HTML/CSS/JS, so serving it is a security-first
 * job:
 *
 *  - path traversal is impossible: every request path is resolved against the
 *    root and rejected if it escapes (same discipline as agent/tools.ts);
 *  - `.git` is never served;
 *  - membership is required (cookie → user → project member);
 *  - the response carries a strict CSP: `connect-src 'none'` means the
 *    agent-written JS cannot call our API (or anywhere) even though the auth
 *    cookie rides along on subresource loads; combined with the client's
 *    `sandbox="allow-scripts"` iframe (opaque origin, no parent access), the
 *    preview can render and run but cannot exfiltrate or act on the viewer's
 *    session.
 *
 * `'self'` in the CSP matches the URL origin the document was served from
 * (per CSP3), not the sandbox's opaque origin, so relative subresources load.
 */

// Preview documents may run their own inline scripts/styles and load same-origin
// assets, images and fonts — but must not open any network connection.
const PREVIEW_CSP = [
  // `sandbox allow-scripts` (no allow-same-origin) forces an opaque origin even
  // on a DIRECT navigation (the "open in new tab" link), so agent-written HTML
  // can never touch our cookies/localStorage/API — same guarantee the iframe's
  // sandbox attribute gives, now enforced at the response layer too.
  'sandbox allow-scripts',
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Resolve a request subpath against a root, rejecting escapes and .git.
 * Two layers: a lexical containment check on the requested path, then a
 * REALPATH containment check — the agent can create symlinks inside its
 * worktree (run_command node → fs.symlinkSync('/etc', 'link')), and serving
 * through one would be an arbitrary-file read. Same discipline as
 * agent/tools.ts resolveSafe.
 */
function resolveInRoot(root: string, subpath: string): string | null {
  const resolvedRoot = path.resolve(root)
  const decoded = safeDecode(subpath)
  if (decoded === null || decoded.includes('\0')) return null
  const resolved = path.resolve(resolvedRoot, '.' + path.sep + decoded)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null
  const rel = path.relative(resolvedRoot, resolved).toLowerCase()
  if (rel === '.git' || rel.startsWith('.git' + path.sep)) return null
  // realpath layer: follow symlinks on the nearest existing ancestor and
  // reject anything that lands outside the (realpath of the) root
  try {
    let probe = resolved
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe)
      if (parent === probe) return null
      probe = parent
    }
    const realProbe = fs.realpathSync(probe)
    const realRoot = fs.realpathSync(resolvedRoot)
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) return null
  } catch {
    return null
  }
  return resolved
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** Serve a static file from `root`, or a generated index when none exists. */
function serveFromRoot(root: string, rawSubpath: string, reply: FastifyReply): void {
  reply.header('Content-Security-Policy', PREVIEW_CSP)
  reply.header('X-Content-Type-Options', 'nosniff')
  // preview state changes every commit; never let a stale copy stick
  reply.header('Cache-Control', 'no-store')

  const subpath = rawSubpath.replace(/^\/+/, '')
  if (!fs.existsSync(root)) {
    reply.code(404).type('text/html').send(placeholderPage('This workspace no longer exists.'))
    return
  }

  // directory or empty path → index.html, else a generated file listing
  if (subpath === '' || subpath.endsWith('/')) {
    const indexPath = resolveInRoot(root, path.join(subpath, 'index.html'))
    if (indexPath && fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
      sendFile(indexPath, reply)
      return
    }
    reply.code(200).type('text/html').send(directoryIndex(root, subpath))
    return
  }

  const resolved = resolveInRoot(root, subpath)
  if (!resolved) {
    reply.code(403).type('text/html').send(placeholderPage('That path is not allowed.'))
    return
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    // SPA-ish fallback: unknown non-asset path renders the index if present
    const indexPath = resolveInRoot(root, 'index.html')
    if (!path.extname(subpath) && indexPath && fs.existsSync(indexPath)) {
      sendFile(indexPath, reply)
      return
    }
    reply.code(404).type('text/html').send(placeholderPage('Not found in this workspace yet.'))
    return
  }
  sendFile(resolved, reply)
}

const BRIDGE_TAG = '<script src="/preview-kit/bridge.js" defer></script>'

function sendFile(filePath: string, reply: FastifyReply): void {
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const body = fs.readFileSync(filePath)
  if (!type.startsWith('text/html')) {
    reply.type(type).send(body)
    return
  }
  // live co-testing: every page gets the presence bridge (script-src 'self' allows it)
  const html = body.toString('utf8')
  const injected = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${BRIDGE_TAG}</body>`) : html + BRIDGE_TAG
  reply.type(type).send(injected)
}

function directoryIndex(root: string, subpath: string): string {
  let entries: string[] = []
  try {
    const dir = resolveInRoot(root, subpath) ?? root
    entries = fs
      .readdirSync(dir)
      .filter((name) => name !== '.git')
      .sort()
  } catch {
    // ignore
  }
  const list = entries
    .map((name) => `<li><a href="./${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`)
    .join('')
  return placeholderPage(
    entries.length === 0
      ? 'Nothing built yet — as the agent writes files, they’ll appear here. Add an <code>index.html</code> and it renders live.'
      : `<p>No <code>index.html</code> yet. Files in this workspace:</p><ul style="text-align:left;display:inline-block">${list}</ul>`,
  )
}

function placeholderPage(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f0;color:#3b3b37;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
    .box{max-width:32rem;padding:1.5rem 2rem;border:2px solid #111;background:#fbfbf8;text-align:left;line-height:1.6;font-size:14px}
    code{background:#e9e8e2;padding:1px 5px;color:#111;font-family:ui-monospace,monospace;font-size:.9em}
    a{color:#111;text-decoration-color:#d01414;text-underline-offset:3px}
  </style></head><body><div class="box">${bodyHtml}</div></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export async function previewRoutes(app: FastifyInstance, services: Services): Promise<void> {
  // the co-testing bridge: public, static, cacheable — it holds no data
  app.get('/preview-kit/bridge.js', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300').type('text/javascript; charset=utf-8').send(BRIDGE_JS)
  })

  const { projects, sessions } = services
  const requireUser = makeRequireUser(services)

  async function memberOrDeny(projectId: string, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (await projects.isMember(projectId, req.currentUser.id)) return true
    reply
      .code(403)
      .header('Content-Security-Policy', PREVIEW_CSP)
      .type('text/html')
      .send(placeholderPage('You are not a member of this project.'))
    return false
  }

  // --- a session's live worktree
  const serveSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = req.params as { sessionId: string; '*'?: string }
    const session = await sessions.getSession(sessionId)
    if (!session) {
      return reply.code(404).type('text/html').send(placeholderPage('Session not found.'))
    }
    if (!(await memberOrDeny(session.projectId, req, reply))) return
    const owner = await projects.getProject(session.projectId)
    if (owner) await projects.gitFor(owner).ensureCheckout(session.worktreePath)
    serveFromRoot(session.worktreePath, (req.params as { '*'?: string })['*'] ?? '', reply)
  }
  app.get('/preview/session/:sessionId', { preHandler: requireUser }, serveSession)
  app.get('/preview/session/:sessionId/*', { preHandler: requireUser }, serveSession)

  // --- merged main for a project (served from the main checkout / repoPath)
  const serveMain = async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string; '*'?: string }
    const project = await projects.getProject(projectId)
    if (!project) {
      return reply.code(404).type('text/html').send(placeholderPage('Project not found.'))
    }
    if (!(await memberOrDeny(projectId, req, reply))) return
    await projects.gitFor(project).ensureCheckout(project.repoPath)
    serveFromRoot(project.repoPath, (req.params as { '*'?: string })['*'] ?? '', reply)
  }
  // --- live main: everyone's work in progress combined (rebuilt when anyone's work moves)
  const serveLive = async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string; '*'?: string }
    if (!(await projects.getProject(projectId))) return reply.code(404).type('text/html').send(placeholderPage('Project not found.'))
    if (!(await memberOrDeny(projectId, req, reply))) return
    await services.liveMain.get(projectId)
    serveFromRoot(services.liveMain.dirFor(projectId), (req.params as { '*'?: string })['*'] ?? '', reply)
  }
  app.get('/preview/live/:projectId', { preHandler: requireUser }, serveLive)
  app.get('/preview/live/:projectId/*', { preHandler: requireUser }, serveLive)

  app.get('/preview/main/:projectId', { preHandler: requireUser }, serveMain)
  app.get('/preview/main/:projectId/*', { preHandler: requireUser }, serveMain)

  // --- mint a signed URL for the in-app (sandboxed) frame
  app.get('/api/preview-url', { preHandler: requireUser }, async (req, reply) => {
    const q = req.query as { session?: string; main?: string; live?: string }
    let grant: Omit<PreviewGrant, 'e'>
    if (typeof q.session === 'string') {
      const session = await sessions.getSession(q.session)
      if (!session) return reply.code(404).send({ error: 'Session not found' })
      if (!(await projects.isMember(session.projectId, req.currentUser.id))) return reply.code(403).send({ error: 'Not a member of this project' })
      grant = { k: 's', i: session.id, u: req.currentUser.id }
    } else if (typeof q.main === 'string') {
      if (!(await projects.getProject(q.main))) return reply.code(404).send({ error: 'Project not found' })
      if (!(await projects.isMember(q.main, req.currentUser.id))) return reply.code(403).send({ error: 'Not a member of this project' })
      grant = { k: 'm', i: q.main, u: req.currentUser.id }
    } else if (typeof q.live === 'string') {
      if (!(await projects.getProject(q.live))) return reply.code(404).send({ error: 'Project not found' })
      if (!(await projects.isMember(q.live, req.currentUser.id))) return reply.code(403).send({ error: 'Not a member of this project' })
      grant = { k: 'l', i: q.live, u: req.currentUser.id }
    } else {
      return reply.code(400).send({ error: 'session, main or live is required' })
    }
    reply.header('Cache-Control', 'no-store')
    return { url: `/preview/t/${mintPreviewToken(grant, services.config.cookieSecret)}/`, ttlMs: PREVIEW_TOKEN_TTL_MS }
  })

  const serveSigned = async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = req.params as { token: string; '*'?: string }
    const grant = readPreviewToken(token, services.config.cookieSecret)
    const deny = (code: number, msg: string) =>
      reply.code(code).header('Content-Security-Policy', PREVIEW_CSP).type('text/html').send(placeholderPage(msg))
    if (!grant) return deny(403, 'This preview link has expired — reload the page.')
    const projectId = grant.k === 's' ? (await sessions.getSession(grant.i))?.projectId : grant.i
    if (!projectId) return deny(404, 'Not found.')
    if (!(await projects.isMember(projectId, grant.u))) return deny(403, 'You are not a member of this project.')
    const owner = await projects.getProject(projectId)
    if (!owner) return deny(404, 'Not found.')
    let root: string | undefined
    if (grant.k === 'l') {
      await services.liveMain.get(projectId)
      root = services.liveMain.dirFor(projectId)
    } else {
      root = grant.k === 'm' ? owner.repoPath : (await sessions.getSession(grant.i))?.worktreePath
      if (!root) return deny(404, 'Not found.')
      await projects.gitFor(owner).ensureCheckout(root)
    }
    reply.header('Referrer-Policy', 'no-referrer')
    serveFromRoot(root, (req.params as { '*'?: string })['*'] ?? '', reply)
  }
  app.get('/preview/t/:token', serveSigned)
  app.get('/preview/t/:token/*', serveSigned)
}
