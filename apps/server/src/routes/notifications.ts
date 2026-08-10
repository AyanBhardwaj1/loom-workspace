import type { FastifyInstance } from 'fastify'
import type { Services } from '../services'
import { makeRequireUser } from './helpers'

/** F13 — per-user notifications: list + mark-all-read. */
export async function notificationRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const requireUser = makeRequireUser(services)

  app.get('/api/notifications', { preHandler: requireUser }, async (req) => {
    const notifications = await services.notifications.listFor(req.currentUser.id)
    return { notifications }
  })

  app.post('/api/notifications/read-all', { preHandler: requireUser }, async (req) => {
    await services.notifications.markAllRead(req.currentUser.id)
    return { ok: true }
  })
}
