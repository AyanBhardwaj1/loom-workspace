import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SessionDetail, SessionDigest } from '@loom/shared'
import type { Services } from '../services'
import { makeRequireUser, parseBody } from './helpers'

function parseDigest(raw: string | null | undefined): SessionDigest | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionDigest
  } catch {
    return null
  }
}

export async function sessionRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { projects, sessions } = services
  const requireUser = makeRequireUser(services)

  app.post('/api/modules/:id/sessions', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const module = await projects.getModule(id)
    if (!module) return reply.code(404).send({ error: 'Module not found' })
    if (!(await projects.isMember(module.projectId, req.currentUser.id))) {
      return reply.code(403).send({ error: 'You are not a member of this project' })
    }
    const body = parseBody(z.object({ title: z.string().max(120).optional() }), req.body, reply)
    if (!body) return
    const session = await sessions.createSession(id, req.currentUser, body.title)
    return reply.code(201).send({ session: await sessions.toSummary(session) })
  })

  app.get('/api/modules/:id/sessions', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const module = await projects.getModule(id)
    if (!module) return reply.code(404).send({ error: 'Module not found' })
    if (!(await projects.isMember(module.projectId, req.currentUser.id))) {
      return reply.code(403).send({ error: 'You are not a member of this project' })
    }
    const rows = await sessions.listSessionsForModule(id)
    const usage = await sessions.usageTotalsForSessions(rows.map((r) => r.id))
    const out = []
    for (const row of rows) {
      const summary = await sessions.toSummary(row)
      const u = usage.get(row.id) ?? { tokens: 0, costUsd: 0 }
      out.push({
        ...summary,
        changeCount: await sessions.countChangesForSession(row.id),
        tokens: u.tokens,
        costUsd: u.costUsd,
      })
    }
    return { sessions: out }
  })

  app.get('/api/sessions/:id', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = await sessions.getSession(id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (!(await projects.isMember(session.projectId, req.currentUser.id))) {
      return reply.code(403).send({ error: 'You are not a member of this project' })
    }
    const query = req.query as { afterSeq?: string }
    const afterSeq = query.afterSeq ? Number(query.afterSeq) : 0
    const events = await sessions.getEvents(id, Number.isFinite(afterSeq) ? afterSeq : 0)
    const module = await projects.getModule(session.moduleId)
    const detail: SessionDetail = {
      session: await sessions.toSummary(session),
      moduleName: module?.name ?? 'Unknown module',
      moduleEmoji: module?.emoji ?? '📦',
      events,
      lastSeq: events.length > 0 ? (events[events.length - 1]!.seq ?? 0) : 0,
      digest: parseDigest(session.digest),
    }
    return detail
  })

  app.post('/api/sessions/:id/fork', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const source = await sessions.getSession(id)
    if (!source) return reply.code(404).send({ error: 'Session not found' })
    if (!(await projects.isMember(source.projectId, req.currentUser.id))) {
      return reply.code(403).send({ error: 'You are not a member of this project' })
    }
    const body = parseBody(z.object({ atEventId: z.string().optional() }), req.body, reply)
    if (!body) return
    try {
      const fork = await sessions.forkSession(id, req.currentUser, body.atEventId)
      // F13 — tell the source driver their work grew a branch
      if (source.driverUserId !== req.currentUser.id) {
        await services.notifications.create({
          userId: source.driverUserId,
          kind: 'fork',
          text: `${req.currentUser.name} forked your session "${source.title}"`,
          projectId: source.projectId,
          sessionId: fork.id,
        })
      }
      return reply.code(201).send({ session: await sessions.toSummary(fork) })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Fork failed' })
    }
  })

  // F11 — share links: driver mints a revocable read-only token
  app.post('/api/sessions/:id/share', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = await sessions.getSession(id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (session.driverUserId !== req.currentUser.id) {
      return reply.code(403).send({ error: 'Only the driver can share a session' })
    }
    const token = session.shareToken ?? (await sessions.setShareToken(id))
    return { token, url: `/shared/${token}` }
  })

  app.delete('/api/sessions/:id/share', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = await sessions.getSession(id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (session.driverUserId !== req.currentUser.id) {
      return reply.code(403).send({ error: 'Only the driver can revoke a share link' })
    }
    await sessions.clearShareToken(id)
    return { ok: true }
  })

  // F11 — the public read-only view: token IS the credential (no login)
  app.get('/api/shared/:token', async (req, reply) => {
    const { token } = req.params as { token: string }
    if (!token || token.length < 16) return reply.code(404).send({ error: 'Not found' })
    const session = await sessions.getSessionByShareToken(token)
    if (!session) return reply.code(404).send({ error: 'This link was revoked or never existed' })
    const events = await sessions.getEvents(session.id)
    const module = await projects.getModule(session.moduleId)
    const detail: SessionDetail = {
      session: await sessions.toSummary(session),
      moduleName: module?.name ?? 'Unknown module',
      moduleEmoji: module?.emoji ?? '📦',
      events,
      lastSeq: events.length > 0 ? (events[events.length - 1]!.seq ?? 0) : 0,
      digest: parseDigest(session.digest),
    }
    return detail
  })

  app.post('/api/sessions/:id/end', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = await sessions.getSession(id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (session.driverUserId !== req.currentUser.id) {
      return reply.code(403).send({ error: 'Only the driver can end a session' })
    }
    await sessions.endSession(id)
    return { ok: true }
  })
}
