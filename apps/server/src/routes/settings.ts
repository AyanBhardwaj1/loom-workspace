import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Services } from '../services'
import { makeRequireUser, parseBody } from './helpers'

const updateSchema = z.object({
  provider: z.enum(['anthropic', 'openrouter']),
  apiKey: z.string().min(8).max(400),
  model: z.string().max(200).optional(),
  baseUrl: z.string().url().max(300).optional(),
})

/**
 * Runtime AI provider settings: paste a key in the UI → the whole server
 * switches from the mock to a real LLM, live, no restart. The key is stored
 * in the app's own database (this is a self-hosted tool) and never echoed
 * back — GET only returns a masked hint.
 */
export async function settingsRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const requireUser = makeRequireUser(services)

  app.get('/api/settings/ai', { preHandler: requireUser }, async () => {
    return services.runtime.describe()
  })

  app.put('/api/settings/ai', { preHandler: requireUser }, async (req, reply) => {
    const body = parseBody(updateSchema, req.body, reply)
    if (!body) return
    const res = await services.runtime.configure(body)
    if (!res.ok) return reply.code(400).send({ error: res.error })
    return res.settings
  })

  app.delete('/api/settings/ai', { preHandler: requireUser }, async () => {
    return services.runtime.clear()
  })
}
