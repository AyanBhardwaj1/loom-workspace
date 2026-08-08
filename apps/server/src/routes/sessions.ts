import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SessionDetail } from '@loom/shared'
import type { Services } from '../services'
import { makeRequireUser, parseBody } from './helpers'

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
    const out = []
    for (const row of rows) {
      const summary = await sessions.toSummary(row)
      out.push({ ...summary, changeCount: await sessions.countChangesForSession(row.id) })
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
      return reply.code(201).send({ session: await sessions.toSummary(fork) })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Fork failed' })
    }
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
