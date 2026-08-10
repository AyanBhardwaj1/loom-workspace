import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { toPublicUser } from '../auth/service'
import type { Services } from '../services'
import { clearSessionCookie, makeRequireUser, parseBody, readSessionToken, setSessionCookie } from './helpers'

const signupSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(200),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export async function authRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { auth, config } = services
  const requireUser = makeRequireUser(services)

  app.post('/api/auth/signup', async (req, reply) => {
    const body = parseBody(signupSchema, req.body, reply)
    if (!body) return
    const res = await auth.signup(body.name, body.email, body.password)
    if (!res.ok) return reply.code(409).send({ error: res.error })
    const token = await auth.createAuthSession(res.user.id)
    setSessionCookie(reply, token, config, req)
    return { user: toPublicUser(res.user) }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const body = parseBody(loginSchema, req.body, reply)
    if (!body) return
    const user = await auth.login(body.email, body.password)
    if (!user) return reply.code(401).send({ error: 'Wrong email or password' })
    const token = await auth.createAuthSession(user.id)
    setSessionCookie(reply, token, config, req)
    return { user: toPublicUser(user) }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readSessionToken(req, config)
    if (token) await auth.revokeToken(token)
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => {
    return { user: toPublicUser(req.currentUser) }
  })

  if (config.isDev) {
    // Dev quick-login: the login page shows one-click buttons for the seeded
    // founders. Registered only when NODE_ENV !== 'production'.
    app.get('/api/auth/dev-users', async () => {
      const users = await auth.listUsers(10)
      return { users: users.map(toPublicUser) }
    })

    app.post('/api/auth/dev-login', async (req, reply) => {
      const body = parseBody(z.object({ userId: z.string() }), req.body, reply)
      if (!body) return
      const user = await auth.getUserById(body.userId)
      if (!user) return reply.code(404).send({ error: 'User not found' })
      const token = await auth.createAuthSession(user.id)
      setSessionCookie(reply, token, config, req)
      return { user: toPublicUser(user) }
    })
  }
}
