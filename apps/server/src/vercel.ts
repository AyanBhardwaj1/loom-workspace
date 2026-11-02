import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitUntil } from '@vercel/functions'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import { loadConfig } from './env'
import { setKeepAlive } from './platform/keepAlive'
import { createServices } from './services'

/**
 * Vercel function entry. One Fastify app per instance (built on first
 * request, reused while the instance is warm); every request is handed to
 * it as a plain Node request. Work that must outlive a response — agent
 * turns, realtime outbox writes — is kept alive with `waitUntil`.
 */
let appPromise: Promise<FastifyInstance> | null = null

function app(): Promise<FastifyInstance> {
  appPromise ??= (async () => {
    const services = await createServices(loadConfig())
    const a = await buildApp(services)
    await a.ready()
    return a
  })().catch((err) => {
    appPromise = null
    throw err
  })
  return appPromise
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setKeepAlive((p) => {
    try {
      waitUntil(p)
    } catch {
      /* outside Vercel (local smoke tests): the process stays up anyway */
    }
  })
  // routes rewrite everything to this one function; the original path rides along
  const original = req.headers['x-loom-path']
  if (typeof original === 'string' && original.startsWith('/')) {
    // the rewrite keeps the query on the function URL; carry it over to the original path
    const q = req.url?.indexOf('?') ?? -1
    req.url = original + (q >= 0 ? req.url!.slice(q) : '')
  }
  const a = await app()
  await new Promise<void>((resolve) => {
    res.on('finish', resolve)
    res.on('close', resolve)
    a.server.emit('request', req, res)
  })
}
