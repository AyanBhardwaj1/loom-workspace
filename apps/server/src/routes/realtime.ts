import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PresenceUser, ServerMessage } from '@loom/shared'
import { projectTopic, sessionTopic, userTopic } from '../realtime/bus'
import type { Services } from '../services'
import { makeRequireUser, parseBody } from './helpers'

const POLL_WAIT_MS = 8_000
const POLL_STEP_MS = 300
const PRESENCE_WINDOW_MS = 20_000
const MAX_ROWS = 400
const OVERLAP = 25

const pollBody = z.object({
  clientId: z.string().min(8).max(64),
  /** last outbox id seen; null = "start from now" (catch-up covers the persisted past) */
  cursor: z.number().int().nonnegative().nullable(),
  sessions: z.array(z.string().max(64)).max(40),
  projects: z.array(z.string().max(64)).max(20),
  viewing: z.string().max(64).nullable(),
  reading: z.string().max(64).nullable(),
  /** 0 = answer immediately (the first poll after a state change) */
  waitMs: z.number().int().min(0).max(POLL_WAIT_MS).optional(),
})

/**
 * Realtime over plain HTTP, for platforms without long-lived sockets
 * (Vercel). The browser long-polls `/api/rt/poll`, declaring what it is
 * subscribed to and looking at; the server answers with every bus message
 * for those topics since its cursor (the DB outbox), plus presence computed
 * from every tab's heartbeat. Client→server messages go to `/api/rt/send`
 * and run through the same hub logic as WebSocket messages.
 */
export async function realtimeRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { dbh, sessions, projects, hub } = services
  const requireUser = makeRequireUser(services)
  const rt = { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } }, preHandler: requireUser }

  /** membership is checked per topic; cached per instance briefly */
  const memberCache = new Map<string, { ok: boolean; projectId: string | null; at: number }>()
  const sessionAccess = async (userId: string, sessionId: string) => {
    const key = `s:${userId}:${sessionId}`
    const hit = memberCache.get(key)
    if (hit && Date.now() - hit.at < 60_000) return hit
    const session = await sessions.getSession(sessionId)
    const ok = Boolean(session && (await projects.isMember(session.projectId, userId)))
    const v = { ok, projectId: session?.projectId ?? null, at: Date.now() }
    memberCache.set(key, v)
    return v
  }
  const projectAccess = async (userId: string, projectId: string) => {
    const key = `p:${userId}:${projectId}`
    const hit = memberCache.get(key)
    if (hit && Date.now() - hit.at < 60_000) return hit.ok
    const ok = await projects.isMember(projectId, userId)
    memberCache.set(key, { ok, projectId, at: Date.now() })
    return ok
  }

  app.post('/api/rt/send', rt, async (req, reply) => {
    const body = parseBody(z.object({ clientId: z.string().min(8).max(64), messages: z.array(z.string().max(30_000)).max(50) }), req.body, reply)
    if (!body) return
    const replies = await hub.handleHttp(req.currentUser, body.clientId, body.messages)
    await services.bus.flush?.()
    return { replies }
  })

  app.post('/api/rt/poll', rt, async (req, reply) => {
    const body = parseBody(pollBody, req.body, reply)
    if (!body) return
    const { db, t } = dbh
    const user = req.currentUser

    // what this tab may actually hear
    const allowedSessions: string[] = []
    const sessionProjects = new Set<string>()
    for (const id of new Set(body.sessions)) {
      const a = await sessionAccess(user.id, id)
      if (a.ok) {
        allowedSessions.push(id)
        if (a.projectId) sessionProjects.add(a.projectId)
      }
    }
    const allowedProjects: string[] = []
    for (const id of new Set(body.projects)) if (await projectAccess(user.id, id)) allowedProjects.push(id)
    const viewing = body.viewing && (await sessionAccess(user.id, body.viewing)).ok ? body.viewing : null
    const viewingProject = viewing ? (await sessionAccess(user.id, viewing)).projectId : null

    // heartbeat + declared state (this row IS this tab's presence)
    const now = new Date().toISOString()
    const row = {
      userId: user.id,
      projectIds: JSON.stringify(allowedProjects),
      sessionIds: JSON.stringify(allowedSessions),
      viewing,
      viewingProject,
      readingEventId: viewing ? body.reading : null,
      lastSeen: now,
    }
    await db.insert(t.rtClients).values({ clientId: body.clientId, ...row }).onConflictDoUpdate({ target: t.rtClients.clientId, set: row })

    const topics = [userTopic(user.id), ...allowedSessions.map(sessionTopic), ...allowedProjects.map(projectTopic)]
    let cursor: number = body.cursor ?? -1
    if (cursor < 0) {
      const [max] = await db.select({ id: sql<number>`coalesce(max(${t.rtOutbox.id}), 0)` }).from(t.rtOutbox)
      cursor = Number(max?.id ?? 0)
    }

    const messages: Array<ServerMessage & { _oid?: number }> = []
    const deadline = Date.now() + (body.waitMs ?? POLL_WAIT_MS)
    for (;;) {
      // read a closed window (cursor, top]: rows that land after `top` wait for the
      // next poll instead of being skipped. A small overlap below the cursor re-reads
      // rows a concurrent writer committed out of id order; the client dedupes by _oid.
      const [maxRow] = await db.select({ id: sql<number>`coalesce(max(${t.rtOutbox.id}), 0)` }).from(t.rtOutbox)
      const top = Number(maxRow?.id ?? 0)
      const rows = await db
        .select()
        .from(t.rtOutbox)
        .where(and(gt(t.rtOutbox.id, Math.max(0, cursor - OVERLAP)), lte(t.rtOutbox.id, top), inArray(t.rtOutbox.topic, topics)))
        .orderBy(asc(t.rtOutbox.id))
        .limit(MAX_ROWS)
      const fresh = rows.some((r) => r.id > cursor)
      if (fresh || Date.now() >= deadline || req.raw.destroyed) {
        for (const r of rows) {
          try {
            messages.push({ ...(JSON.parse(r.body) as ServerMessage), _oid: r.id })
          } catch {
            /* skip a corrupt row */
          }
        }
        // a full page means more is waiting: resume right after the last row read
        cursor = rows.length === MAX_ROWS ? rows[rows.length - 1]!.id : Math.max(cursor, top)
        break
      }
      // nothing for us up to `top`; keep the overlap margin below it
      cursor = Math.max(cursor, top - OVERLAP)
      await new Promise((r) => setTimeout(r, POLL_STEP_MS))
    }

    // presence: every live tab in each project this tab watches
    if (allowedProjects.length > 0) {
      const since = new Date(Date.now() - PRESENCE_WINDOW_MS).toISOString()
      const live = await db.select().from(t.rtClients).where(gt(t.rtClients.lastSeen, since))
      const userIds = [...new Set(live.map((c) => c.userId))]
      const users = userIds.length > 0 ? await db.select().from(t.users).where(inArray(t.users.id, userIds)) : []
      const byId = new Map(users.map((u) => [u.id, u]))
      for (const projectId of allowedProjects) {
        const present = new Map<string, PresenceUser>()
        for (const c of live) {
          const projectsOf = JSON.parse(c.projectIds) as string[]
          if (!projectsOf.includes(projectId) && c.viewingProject !== projectId) continue
          const u = byId.get(c.userId)
          if (!u) continue
          const prev = present.get(u.id)
          const here = c.viewingProject === projectId
          present.set(u.id, {
            userId: u.id,
            name: u.name,
            avatarColor: u.avatarColor,
            viewing: (here ? c.viewing : null) ?? prev?.viewing ?? null,
            readingEventId: (here ? c.readingEventId : null) ?? prev?.readingEventId ?? null,
          })
        }
        messages.push({ t: 'presence', projectId, users: [...present.values()] })
      }
    }
    return { cursor, messages }
  })

  // a tab closing says goodbye so it drops out of presence at once
  app.post('/api/rt/leave', rt, async (req, reply) => {
    const body = parseBody(z.object({ clientId: z.string().min(8).max(64) }), req.body, reply)
    if (!body) return
    const { db, t } = dbh
    await db.delete(t.rtClients).where(and(eq(t.rtClients.clientId, body.clientId), eq(t.rtClients.userId, req.currentUser.id)))
    return { ok: true }
  })
}
