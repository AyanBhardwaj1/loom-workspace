import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { SESSION_COOKIE, signValue, unsignValue } from '../auth/cookies'
import type { ServerConfig } from '../env'
import type { Services } from '../services'

export type UserRow = typeof import('../db/schema.sqlite').users.$inferSelect

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: UserRow
  }
}

const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

export function setSessionCookie(reply: FastifyReply, token: string, config: ServerConfig): void {
  reply.setCookie(SESSION_COOKIE, signValue(token, config.cookieSecret), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
    // left non-secure so the local two-browser demo works over http;
    // set COOKIE_SECURE=1 behind TLS in production
    secure: process.env.COOKIE_SECURE === '1',
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

export function readSessionToken(req: FastifyRequest, config: ServerConfig): string | null {
  const signed = req.cookies[SESSION_COOKIE]
  return signed ? unsignValue(signed, config.cookieSecret) : null
}

/** preHandler: resolve the cookie to a user or 401. */
export function makeRequireUser(services: Services) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readSessionToken(req, services.config)
    const user = token ? await services.auth.resolveToken(token) : null
    if (!user) {
      return reply.code(401).send({ error: 'Not signed in' })
    }
    req.currentUser = user
  }
}

/** Validate a request body; sends a 400 and returns null on failure. */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  reply: FastifyReply,
): z.infer<S> | null {
  const res = schema.safeParse(body ?? {})
  if (!res.success) {
    reply.code(400).send({ error: 'Invalid request', details: res.error.flatten() })
    return null
  }
  return res.data
}
