import crypto from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ulid } from 'ulid'
import { z } from 'zod'
import { deriveSessionState, eventGist } from '@loom/shared'
import { describe } from '../coord/engine'
import type { Services } from '../services'
import { makeRequireUser, parseBody, type UserRow } from './helpers'

/**
 * Loom as an MCP server (Streamable HTTP, JSON responses) — so each teammate's
 * own Claude Code, Codex or Cursor joins the room without switching tools.
 *
 * Laptop agents ANNOUNCE what they're changing (paths and symbol names, never
 * contents) and read the RADAR: who else is in those files, and whether a
 * Loom session's test-merge says it would conflict. They can read sessions,
 * live main and files, and SUGGEST to a session's driver — but never steer a
 * session directly: in Loom a human decides what an agent runs.
 */

const PROTOCOL = '2025-06-18'
const WORK_TTL_MS = 20 * 60_000

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

const INSTRUCTIONS = `Loom keeps your team's coding agents in sync.
- When you start a task, and after you edit files, call loom_announce with the files and the function/rule names you are changing (names only — never file contents).
- Before editing a file teammates may be in, call loom_radar. If it reports a conflict with a teammate's work, adapt your change now while it is small: keep both intents, prefer different functions, never undo their work.
- To propose work to a teammate's Loom session, use loom_suggest — the session's driver decides.`

const TOOLS = [
  {
    name: 'loom_list_projects',
    description: 'List the Loom projects you are a member of, with their ids and how many sessions are live.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'loom_announce',
    description:
      'Tell your team what you are changing right now (names only, never contents). Call when you start a task and after edits. Returns any overlaps or conflict risks with teammates. Pass files: [] to clear your announcement.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        branch: { type: 'string', description: 'your git branch' },
        agent: { type: 'string', description: 'e.g. claude-code, codex, cursor' },
        summary: { type: 'string', description: 'one line: the task' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, symbols: { type: 'array', items: { type: 'string' } } }, required: ['path'] },
        },
      },
      required: ['projectId', 'branch', 'files'],
    },
  },
  {
    name: 'loom_radar',
    description: "Who on your team is changing what right now (Loom sessions and laptop agents), where work overlaps, and any conflicts a test-merge found. Read before editing shared files.",
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, branch: { type: 'string', description: 'your branch, to highlight your overlaps' } }, required: ['projectId'] },
  },
  {
    name: 'loom_list_sessions',
    description: "List a project's live Loom sessions: title, who is driving, branch and what the session is doing now.",
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
  },
  {
    name: 'loom_read_session',
    description: 'Read a Loom session: its state, plan, test cases and the latest events (prompts, agent messages, commits, checks).',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, limit: { type: 'number', description: 'events to return (default 25, max 100)' } }, required: ['sessionId'] },
  },
  {
    name: 'loom_live_main',
    description: "Live main: everyone's in-progress work combined. Shows which work fits, which doesn't yet (and whose work it collides with), and whether checks pass on the combination.",
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
  },
  {
    name: 'loom_read_file',
    description: "Read a file from the project's main branch, or from a Loom session's branch.",
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, path: { type: 'string' }, sessionId: { type: 'string' } }, required: ['projectId', 'path'] },
  },
  {
    name: 'loom_suggest',
    description: "Propose a next step to a teammate's Loom session. Its driver sees it and decides — it never runs on its own.",
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, text: { type: 'string' } }, required: ['sessionId', 'text'] },
  },
] as const

type Args = Record<string, unknown>

export async function mcpRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { dbh, projects, sessions, radar, liveMain } = services
  const requireUser = makeRequireUser(services)

  // ---------------------------------------------------------------- tokens
  app.get('/api/agent-tokens', { preHandler: requireUser }, async (req) => {
    const { db, t } = dbh
    const rows = await db.select().from(t.agentTokens).where(eq(t.agentTokens.userId, req.currentUser.id)).orderBy(desc(t.agentTokens.createdAt))
    return { tokens: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt })) }
  })

  app.post('/api/agent-tokens', { preHandler: requireUser }, async (req, reply) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(60) }), req.body, reply)
    if (!body) return
    const { db, t } = dbh
    const existing = await db.select({ id: t.agentTokens.id }).from(t.agentTokens).where(eq(t.agentTokens.userId, req.currentUser.id))
    if (existing.length >= 20) return reply.code(409).send({ error: 'You have 20 agent tokens — revoke one first' })
    const token = `loom_pat_${crypto.randomBytes(24).toString('base64url')}`
    const id = ulid()
    await db.insert(t.agentTokens).values({ id, userId: req.currentUser.id, name: body.name, tokenHash: hashToken(token), createdAt: new Date().toISOString(), lastUsedAt: null })
    // shown once; only its hash is stored
    return { id, name: body.name, token }
  })

  app.delete('/api/agent-tokens/:id', { preHandler: requireUser }, async (req) => {
    const { id } = req.params as { id: string }
    const { db, t } = dbh
    await db.delete(t.agentTokens).where(and(eq(t.agentTokens.id, id), eq(t.agentTokens.userId, req.currentUser.id)))
    return { ok: true }
  })

  const tokenUser = async (req: FastifyRequest): Promise<UserRow | null> => {
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null
    if (!token || !token.startsWith('loom_pat_')) return null
    const { db, t } = dbh
    const [row] = await db.select().from(t.agentTokens).where(eq(t.agentTokens.tokenHash, hashToken(token)))
    if (!row) return null
    const [user] = await db.select().from(t.users).where(eq(t.users.id, row.userId))
    if (!user) return null
    void db.update(t.agentTokens).set({ lastUsedAt: new Date().toISOString() }).where(eq(t.agentTokens.id, row.id)).catch(() => {})
    return user
  }

  // ------------------------------------------------------------------ tools
  const member = async (user: UserRow, projectId: unknown): Promise<string> => {
    if (typeof projectId !== 'string' || !(await projects.isMember(projectId, user.id))) throw new ToolError('Unknown project, or you are not a member')
    return projectId
  }
  const sessionFor = async (user: UserRow, sessionId: unknown) => {
    const s = typeof sessionId === 'string' ? await sessions.getSession(sessionId) : null
    if (!s || !(await projects.isMember(s.projectId, user.id))) throw new ToolError('Unknown session, or you are not a member of its project')
    return s
  }

  const radarText = async (projectId: string, focusKey: string | null): Promise<string> => {
    const r = await radar.forProject(projectId, { fresh: true })
    if (r.items.length === 0) return 'Nobody is working on this project right now.'
    const lines: string[] = []
    for (const i of r.items) {
      const where = i.kind === 'external' ? 'laptop agent' : `Loom session "${i.title}"${i.working ? ' (agent working)' : ''}`
      const files = i.changes.length === 0 ? 'no changes yet' : i.changes.slice(0, 6).map((c) => describe(c.path, c.symbols)).join('; ')
      lines.push(`- ${i.userName} — ${where}, branch ${i.branchName}: ${files}`)
    }
    const ov = r.overlaps.filter((o) => !focusKey || o.a === focusKey || o.b === focusKey)
    if (ov.length > 0) {
      lines.push('', 'Overlaps:')
      for (const o of ov) {
        const a = r.items.find((x) => x.key === o.a)!
        const b = r.items.find((x) => x.key === o.b)!
        const verdict =
          o.conflicts === null
            ? 'unknown'
            : o.conflicts.length > 0
              ? `CONFLICT in ${o.conflicts.map((c) => describe(c.path, c.symbols)).join('; ')} — adapt now while it is small`
              : 'merges cleanly'
        lines.push(`- ${a.userName} & ${b.userName} both change ${o.files.join(', ')}: ${verdict}`)
      }
    }
    return lines.join('\n')
  }

  const call = async (user: UserRow, name: string, a: Args): Promise<string> => {
    switch (name) {
      case 'loom_list_projects': {
        const list = await projects.listProjectsForUser(user.id)
        if (list.length === 0) return 'You are not in any Loom project yet.'
        return list.map((p) => `- ${p.name} (id ${p.id}) — ${p.activeSessionCount} live session${p.activeSessionCount === 1 ? '' : 's'}`).join('\n')
      }
      case 'loom_announce': {
        const projectId = await member(user, a.projectId)
        const branch = typeof a.branch === 'string' && a.branch.trim() ? a.branch.trim().slice(0, 120) : null
        if (!branch) throw new ToolError('branch is required')
        const files = z
          .array(z.object({ path: z.string().min(1).max(300), symbols: z.array(z.string().max(80)).max(20).optional() }))
          .max(50)
          .safeParse(a.files)
        if (!files.success) throw new ToolError('files must be [{path, symbols?}] (at most 50)')
        const { db, t } = dbh
        const id = crypto.createHash('sha1').update(`${user.id}:${projectId}:${branch}`).digest('hex').slice(0, 20)
        if (files.data.length === 0) {
          await db.delete(t.externalWork).where(eq(t.externalWork.id, id))
          radar.invalidate(projectId)
          return 'Cleared your announcement.'
        }
        const now = new Date()
        const row = {
          userId: user.id,
          projectId,
          agent: typeof a.agent === 'string' ? a.agent.slice(0, 40) : 'agent',
          branch,
          files: JSON.stringify(files.data),
          summary: typeof a.summary === 'string' ? a.summary.slice(0, 200) : '',
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + WORK_TTL_MS).toISOString(),
        }
        await db.insert(t.externalWork).values({ id, ...row }).onConflictDoUpdate({ target: t.externalWork.id, set: row })
        radar.invalidate(projectId)
        return `Announced to your team (visible for 20 minutes; announce again after more edits).\n\n${await radarText(projectId, `external:${id}`)}`
      }
      case 'loom_radar': {
        const projectId = await member(user, a.projectId)
        const branch = typeof a.branch === 'string' ? a.branch : null
        const focus = branch ? `external:${crypto.createHash('sha1').update(`${user.id}:${projectId}:${branch}`).digest('hex').slice(0, 20)}` : null
        return radarText(projectId, focus)
      }
      case 'loom_list_sessions': {
        const projectId = await member(user, a.projectId)
        const users = new Map((await projects.getMembers(projectId)).map((u) => [u.id, u.name]))
        const live = await sessions.listActiveSessionsForProject(projectId)
        if (live.length === 0) return 'No live sessions.'
        const out: string[] = []
        for (const s of live) {
          const st = deriveSessionState({ events: await sessions.getEvents(s.id, 0), driverName: users.get(s.driverUserId) })
          out.push(`- "${s.title}" (id ${s.id}) — ${users.get(s.driverUserId) ?? 'someone'} driving, branch ${s.branchName}: ${st.state} · ${st.detail}`)
        }
        return out.join('\n')
      }
      case 'loom_read_session': {
        const s = await sessionFor(user, a.sessionId)
        const events = await sessions.getEvents(s.id, 0)
        const st = deriveSessionState({ events, ended: s.status === 'ended' })
        const limit = Math.min(100, Math.max(1, Number(a.limit) || 25))
        const plan = [...events].reverse().find((e) => e.type === 'plan')
        const tests = [...events].reverse().find((e) => e.type === 'test_plan')
        const lines = [`"${s.title}" — ${st.state}: ${st.detail}`]
        if (plan && plan.type === 'plan') lines.push('Plan:', ...plan.payload.steps.map((x) => `  [${x.status}] ${x.text}`))
        if (tests && tests.type === 'test_plan') lines.push('Test cases:', ...tests.payload.cases.map((c) => `  ${c.id}: ${c.action} → ${c.expect}`))
        lines.push('Latest:', ...events.slice(-limit).map((e) => `  #${e.seq} ${e.type}: ${eventGist(e)}`))
        return lines.join('\n')
      }
      case 'loom_live_main': {
        const projectId = await member(user, a.projectId)
        const lm = await liveMain.get(projectId)
        const lines = [`Live main (main ${lm.mainSha.slice(0, 7)} + everyone's work) — checks: ${lm.checks?.status ?? 'not run'}`]
        for (const e of lm.entries) {
          lines.push(
            e.status === 'in-live-main'
              ? `- ${e.userName} "${e.title}": in live main`
              : e.status === 'doesnt-fit'
                ? `- ${e.userName} "${e.title}": DOESN'T FIT YET — ${e.conflicts.map((c) => describe(c.path, c.symbols)).join('; ')}${e.collidesWith.length ? ` (collides with ${e.collidesWith.join(', ')})` : ''}`
                : `- ${e.userName} "${e.title}": nothing to combine yet`,
          )
        }
        return lines.join('\n')
      }
      case 'loom_read_file': {
        const projectId = await member(user, a.projectId)
        const project = (await projects.getProject(projectId))!
        const filePath = typeof a.path === 'string' ? a.path.replace(/^\/+/, '') : ''
        if (!filePath || filePath.includes('..')) throw new ToolError('path must be a relative path inside the project')
        let ref = 'main'
        if (a.sessionId !== undefined) {
          const s = await sessionFor(user, a.sessionId)
          if (s.projectId !== projectId) throw new ToolError('That session is in another project')
          ref = s.branchName
        }
        try {
          const content = await projects.gitFor(project).showFile(ref, filePath)
          return content.length > 60_000 ? content.slice(0, 60_000) + '\n… (truncated)' : content
        } catch {
          throw new ToolError(`${filePath} doesn't exist on ${ref}`)
        }
      }
      case 'loom_suggest': {
        const s = await sessionFor(user, a.sessionId)
        const text = typeof a.text === 'string' ? a.text.trim().slice(0, 2000) : ''
        if (!text) throw new ToolError('text is required')
        if (s.status === 'ended') throw new ToolError('That session has ended')
        if (s.driverUserId === user.id) throw new ToolError('You drive that session — open it in Loom and send it directly')
        await sessions.addSuggestion(s.id, user, text)
        return `Suggested to "${s.title}". Its driver sees it in Loom and decides.`
      }
      default:
        throw new ToolError(`Unknown tool ${name}`)
    }
  }

  // --------------------------------------------------------------- protocol
  const rpc = async (user: UserRow, msg: { id?: unknown; method?: unknown; params?: unknown }) => {
    const id = msg.id ?? null
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
    switch (msg.method) {
      case 'initialize': {
        const requested = (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion
        return ok({ protocolVersion: requested ?? PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'loom', version: '1.0.0' }, instructions: INSTRUCTIONS })
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: TOOLS })
      case 'tools/call': {
        const p = (msg.params ?? {}) as { name?: string; arguments?: Args }
        if (!p.name || !TOOLS.some((t) => t.name === p.name)) return fail(-32602, `Unknown tool ${p.name}`)
        try {
          const text = await call(user, p.name, p.arguments ?? {})
          await services.bus.flush?.()
          return ok({ content: [{ type: 'text', text }] })
        } catch (err) {
          const message = err instanceof ToolError ? err.message : 'Something went wrong running that tool'
          if (!(err instanceof ToolError)) console.error('[mcp] tool error:', err)
          return ok({ content: [{ type: 'text', text: message }], isError: true })
        }
      }
      default:
        return fail(-32601, `Method not found: ${String(msg.method)}`)
    }
  }

  const unauthorized = (reply: FastifyReply) =>
    reply
      .code(401)
      .header('WWW-Authenticate', 'Bearer realm="loom"')
      .send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or invalid Loom agent token (Authorization: Bearer loom_pat_…)' } })

  app.post('/api/mcp', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = await tokenUser(req)
    if (!user) return unauthorized(reply)
    const body = req.body as unknown
    const msgs = Array.isArray(body) ? body : [body]
    const out = []
    for (const m of msgs.slice(0, 20)) {
      if (!m || typeof m !== 'object') continue
      const msg = m as { id?: unknown; method?: unknown; params?: unknown }
      // notifications carry no id and get no response
      if (msg.id === undefined || msg.id === null) {
        continue
      }
      out.push(await rpc(user, msg))
    }
    if (out.length === 0) return reply.code(202).send()
    return Array.isArray(body) ? out : out[0]
  })
  app.get('/api/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'Use POST (Streamable HTTP, JSON responses)' }))
}

class ToolError extends Error {}

