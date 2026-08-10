import fs from 'node:fs'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import type { WebSocketServer } from 'ws'
import { attachWebSocket } from './realtime/ws'
import { authRoutes } from './routes/auth'
import { devRoutes } from './routes/dev'
import { previewRoutes } from './routes/preview'
import { projectRoutes } from './routes/projects'
import { notificationRoutes } from './routes/notifications'
import { replayRoutes } from './routes/replay'
import { sessionRoutes } from './routes/sessions'
import { settingsRoutes } from './routes/settings'
import type { Services } from './services'

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { config } = services
  // C7 — structured logs with stable request ids across HTTP (and WS upgrade)
  let reqCounter = 0
  const app = Fastify({
    logger: { level: config.isDev ? 'warn' : 'info' },
    bodyLimit: 1024 * 1024,
    // deployment: honor X-Forwarded-* from a fronting proxy/tunnel
    // (Cloudflare Tunnel, nginx, Caddy) so req.protocol reflects real TLS
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? `req_${Date.now().toString(36)}_${++reqCounter}`,
  })

  await app.register(fastifyCookie)

  // C6 — rate limits: generous globally, tight on auth (credential guessing)
  // and session-mutating endpoints. Keyed per IP.
  await app.register(fastifyRateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: () => config.isDev === true && process.env.NODE_ENV === 'test',
  })
  app.addHook('onRoute', (route) => {
    const url = route.url
    if (url.startsWith('/api/auth/login') || url.startsWith('/api/auth/signup')) {
      route.config = { ...route.config, rateLimit: { max: 10, timeWindow: '1 minute' } }
    } else if (/\/api\/sessions\/.*(fork|end|share)/.test(url) || url === '/api/projects/:id/merge') {
      route.config = { ...route.config, rateLimit: { max: 60, timeWindow: '1 minute' } }
    }
  })

  // C6 — CSRF belt-and-braces on top of SameSite=Lax + JSON-only parsing:
  // when a browser sends an Origin on a mutating request, it must match Host
  // (or a PUBLIC_ORIGINS entry, for fronting setups that rewrite Host).
  const extraOrigins = new Set(
    (process.env.PUBLIC_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      .map((o) => {
        try {
          return new URL(o).host
        } catch {
          return o
        }
      }),
  )
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const origin = req.headers.origin
    if (!origin) return // non-browser client (curl, tests)
    try {
      const originHost = new URL(origin).host
      if (originHost !== req.headers.host && !extraOrigins.has(originHost)) {
        return reply.code(403).send({ error: 'Cross-origin request rejected' })
      }
    } catch {
      return reply.code(403).send({ error: 'Cross-origin request rejected' })
    }
  })

  app.get('/api/health', async () => ({ ok: true, agentMode: services.runtime.mode }))

  // C7 — liveness for orchestration and monitors
  app.get('/healthz', async () => ({ ok: true }))

  await authRoutes(app, services)
  await projectRoutes(app, services)
  await sessionRoutes(app, services)
  await settingsRoutes(app, services)
  await previewRoutes(app, services)
  await replayRoutes(app, services)
  await notificationRoutes(app, services)
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
