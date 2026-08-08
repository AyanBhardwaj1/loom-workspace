import fs from 'node:fs'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import type { WebSocketServer } from 'ws'
import { attachWebSocket } from './realtime/ws'
import { authRoutes } from './routes/auth'
import { devRoutes } from './routes/dev'
import { projectRoutes } from './routes/projects'
import { sessionRoutes } from './routes/sessions'
import { settingsRoutes } from './routes/settings'
import type { Services } from './services'

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { config } = services
  const app = Fastify({
    logger: { level: config.isDev ? 'warn' : 'info' },
    bodyLimit: 1024 * 1024,
  })

  await app.register(fastifyCookie)

  app.get('/api/health', async () => ({ ok: true, agentMode: services.runtime.mode }))

  await authRoutes(app, services)
  await projectRoutes(app, services)
  await sessionRoutes(app, services)
  await settingsRoutes(app, services)
  if (config.isDev) {
    await devRoutes(app, services)
  }

  // serve the built frontend when it exists (production / docker)
  if (fs.existsSync(config.webDistPath)) {
    await app.register(fastifyStatic, { root: config.webDistPath, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}

export interface RunningServer {
  app: FastifyInstance
  wss: WebSocketServer
  port: number
  stop(): Promise<void>
}

export async function startServer(services: Services, portOverride?: number): Promise<RunningServer> {
  const app = await buildApp(services)
  const port = portOverride ?? services.config.port
  await app.listen({ port, host: services.config.host })
  const wss = attachWebSocket(app.server, {
    hub: services.hub,
    auth: services.auth,
    config: services.config,
  })
  const address = app.server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  return {
    app,
    wss,
    port: boundPort,
    stop: async () => {
      wss.clients.forEach((c) => c.terminate())
      wss.close()
      await app.close()
    },
  }
}
