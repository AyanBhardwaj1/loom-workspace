import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SessionDetail } from '@loom/shared'
import type { Services } from '../services'
import { readSessionToken } from './helpers'

/**
 * Read-only session replay. This is the one endpoint a shared "replay link"
 * loads, so authorization lives in a single seam — `canAccessReplay` — that is
 * a config flag away from the strategic next step: signed public links an
 * agency can send to a client who has no account.
 *
 * Today: project members only. When `config.publicReplayLinks` is enabled, a
 * request carrying a valid signed `?token` that encodes this sessionId would
 * also pass — the read stays read-only (no fork/drive without an account), so
 * a leaked link exposes a transcript, never write access.
 */
export async function replayRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { sessions, projects } = services

  app.get('/api/replay/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = await sessions.getSession(id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })

    const access = await canAccessReplay(services, req, session.projectId)
    if (access === 'unauthenticated') {
      return reply.code(401).send({ error: 'Sign in to view this replay' })
    }
    if (access === 'forbidden') {
      return reply.code(403).send({ error: 'You do not have access to this replay' })
    }

    const module = await projects.getModule(session.moduleId)
    const events = await sessions.getEvents(id, 0)
    const detail: SessionDetail = {
      session: await sessions.toSummary(session),
      moduleName: module?.name ?? 'Unknown module',
      moduleEmoji: module?.emoji ?? '📦',
      events,
      lastSeq: events.length > 0 ? (events[events.length - 1]!.seq ?? 0) : 0,
    }
    return detail
  })
}

type ReplayAccess = 'ok' | 'unauthenticated' | 'forbidden'

/** The single authorization decision for replay access. */
async function canAccessReplay(
  services: Services,
  req: FastifyRequest,
  projectId: string,
): Promise<ReplayAccess> {
  const token = readSessionToken(req, services.config)
  const user = token ? await services.auth.resolveToken(token) : null

  // FUTURE (config.publicReplayLinks): accept a valid signed ?token that
  // encodes this session and grant read-only access here, before the
  // membership check — that is the whole change needed for client links.

  if (!user) return 'unauthenticated'
  return (await services.projects.isMember(projectId, user.id)) ? 'ok' : 'forbidden'
}
