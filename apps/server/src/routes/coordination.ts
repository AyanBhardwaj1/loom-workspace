import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { deriveSessionState, type SessionEvent } from '@loom/shared'
import type { Services } from '../services'
import { makeRequireUser, parseBody } from './helpers'

/** the Board's five lanes */
export type Lane = 'needs-you' | 'working' | 'to-review' | 'idle' | 'merged'

const STOP = new Set(
  'a an the and or to of in on for with from by is are be it this that these those add make build create update change fix new please can you we our my your some page app site into as at its use using also then'.split(' '),
)
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))

/** how alike two task descriptions are: shared significant words over the smaller set */
export function taskSimilarity(a: string, b: string): number {
  const A = words(a)
  const B = words(b)
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / Math.min(A.size, B.size)
}

/**
 * The room's coordination surfaces: the Board (every session by lane, with
 * its branch-vs-main status and overlaps), Live main (everyone's work
 * combined), and the duplicate-task check before a new task starts.
 */
export async function coordinationRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { projects, sessions, radar, liveMain } = services
  const requireUser = makeRequireUser(services)

  const memberProject = async (id: string, userId: string, reply: FastifyReply) => {
    const project = await projects.getProject(id)
    if (!project) {
      reply.code(404).send({ error: 'Project not found' })
      return null
    }
    if (!(await projects.isMember(id, userId))) {
      reply.code(403).send({ error: 'You are not a member of this project' })
      return null
    }
    return project
  }

  app.get('/api/projects/:id/board', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!(await memberProject(id, req.currentUser.id, reply))) return
    const r = await radar.forProject(id)
    const now = Date.now()
    let conflictsCaught = 0
    const openKeys = new Set<string>()
    const resolvedKeys = new Set<string>()
    const cards = []
    for (const item of r.items) {
      if (item.kind !== 'session' || !item.sessionId) continue
      const s = await sessions.getSession(item.sessionId)
      if (!s) continue
      const events: SessionEvent[] = await sessions.getEvents(s.id, 0)
      const state = deriveSessionState({ events, ended: s.status === 'ended', driverName: item.userName, now })
      const open = new Map<string, { withName: string; items: Array<{ path: string; symbols: string[] }> }>()
      for (const e of events) {
        if (e.type !== 'coordination') continue
        if (e.payload.kind === 'conflict') open.set(e.payload.key, { withName: e.payload.withName, items: e.payload.items })
        if (e.payload.kind === 'resolved') {
          open.delete(e.payload.key)
          resolvedKeys.add(e.payload.key)
        }
      }
      for (const k of open.keys()) openKeys.add(k)
      const main = r.vsMain[item.key]!
      const hadCommits = events.some((e) => e.type === 'commit')
      const lane: string =
        ['awaiting-approval', 'your-move', 'needs-testing', 'error'].includes(state.state) || main.status === 'conflicts' || open.size > 0
          ? 'needs-you'
          : state.state === 'working' || state.state === 'checking'
            ? 'working'
            : hadCommits && main.ahead === 0 && item.changes.length === 0
              ? 'merged'
              : item.changes.length > 0
                ? 'to-review'
                : 'idle'
      const overlaps = r.overlaps
        .filter((o) => o.a === item.key || o.b === item.key)
        .map((o) => {
          const other = r.items.find((x) => x.key === (o.a === item.key ? o.b : o.a))!
          return {
            withName: other.userName,
            withTitle: other.title,
            withSessionId: other.sessionId,
            external: other.kind === 'external',
            files: o.files,
            conflicts: o.conflicts ?? [],
          }
        })
      cards.push({
        sessionId: s.id,
        title: s.title,
        moduleName: item.moduleName,
        driver: { id: item.userId, name: item.userName, color: item.userColor },
        branchName: s.branchName,
        lane,
        state,
        main,
        overlaps,
        openConflicts: [...open.values()],
        files: item.changes,
        lastEventAt: s.lastEventAt,
      })
    }
    conflictsCaught = resolvedKeys.size
    const external = r.items
      .filter((i) => i.kind === 'external')
      .map((i) => ({ key: i.key, userName: i.userName, userColor: i.userColor, branchName: i.branchName, title: i.title, files: i.changes, since: i.createdAt }))
    return { computedAt: r.computedAt, cards, external, conflictsCaught, openConflicts: openKeys.size }
  })

  app.get('/api/projects/:id/live-main', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!(await memberProject(id, req.currentUser.id, reply))) return
    return liveMain.get(id)
  })

  /** before a task starts: is someone already doing this? (human decides — "Open theirs" or "Start anyway") */
  app.post('/api/sessions/:id/similar', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = parseBody(z.object({ text: z.string().min(1).max(4000) }), req.body, reply)
    if (!body) return
    const me = await sessions.getSession(id)
    if (!me) return reply.code(404).send({ error: 'Session not found' })
    if (!(await projects.isMember(me.projectId, req.currentUser.id))) return reply.code(403).send({ error: 'You are not a member of this project' })
    const users = new Map((await projects.getMembers(me.projectId)).map((u) => [u.id, u.name]))
    const matches = []
    for (const s of await sessions.listActiveSessionsForProject(me.projectId)) {
      // a teammate already on it — your own parallel sessions are your call
      if (s.id === id || s.driverUserId === req.currentUser.id) continue
      const events = await sessions.getEvents(s.id, 0)
      const asks = events.flatMap((e) => (e.type === 'user_message' ? [e.payload.text] : []))
      const plan = [...events].reverse().find((e) => e.type === 'plan')
      const corpus = [s.title, ...asks.slice(-3), ...(plan && plan.type === 'plan' ? plan.payload.steps.map((x) => x.text) : [])].join(' ')
      const score = Math.max(taskSimilarity(body.text, corpus), ...asks.map((a) => taskSimilarity(body.text, a)))
      if (score >= 0.5) matches.push({ sessionId: s.id, title: s.title, driverName: users.get(s.driverUserId) ?? 'A teammate', ask: asks[asks.length - 1] ?? s.title, score })
    }
    matches.sort((a, b) => b.score - a.score)
    return { matches: matches.slice(0, 3) }
  })
}
