import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Services } from '../services'
import { makeRequireUser } from './helpers'

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

function sendFile(filePath: string, reply: FastifyReply): void {
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  reply.type(type).send(fs.readFileSync(filePath))
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
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#9a99b0;font-family:system-ui,-apple-system,sans-serif}
    .box{max-width:32rem;padding:2rem;text-align:center;line-height:1.6;font-size:14px}
    code{background:#1a1a24;padding:2px 6px;border-radius:6px;color:#b9aef8;font-size:.9em}
    a{color:#8b7cf6}
  </style></head><body><div class="box">${bodyHtml}</div></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export async function previewRoutes(app: FastifyInstance, services: Services): Promise<void> {
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
    serveFromRoot(project.repoPath, (req.params as { '*'?: string })['*'] ?? '', reply)
  }
  app.get('/preview/main/:projectId', { preHandler: requireUser }, serveMain)
  app.get('/preview/main/:projectId/*', { preHandler: requireUser }, serveMain)
}
