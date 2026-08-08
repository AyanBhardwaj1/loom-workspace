import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Services } from '../services'
import { makeRequireUser, parseBody } from './helpers'

/** Dev-only endpoints (ghost collaborator). Registered when NODE_ENV !== 'production'. */
export async function devRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { ghost, projects } = services
  const requireUser = makeRequireUser(services)

  app.post('/api/dev/ghost', { preHandler: requireUser }, async (req, reply) => {
    const body = parseBody(
      z.object({ projectId: z.string(), moduleId: z.string().optional() }),
      req.body,
      reply,
    )
    if (!body) return
    if (!(await projects.isMember(body.projectId, req.currentUser.id))) {
      return reply.code(403).send({ error: 'You are not a member of this project' })
    }
    const res = await ghost.start(body.projectId, body.moduleId)
    if (!res.ok) return reply.code(409).send({ error: res.error })
    return { ok: true, sessionId: res.sessionId }
  })
}
