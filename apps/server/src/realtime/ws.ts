import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type { AuthService } from '../auth/service'
import { parseCookieHeader, SESSION_COOKIE, unsignValue } from '../auth/cookies'
import type { ServerConfig } from '../env'
import type { Hub } from './hub'

/**
 * One WS endpoint (`/ws`), authenticated during the HTTP upgrade via the same
 * signed session cookie the HTTP API uses.
 */
const HEARTBEAT_MS = 30_000

export function attachWebSocket(
  server: Server,
  deps: { hub: Hub; auth: AuthService; config: ServerConfig },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  // C4 — heartbeat: ping every 30s; a socket that misses a full interval
  // (no pong — browsers reply automatically) is considered dead and
  // terminated so its presence and subscriptions release promptly.
  const alive = new WeakMap<import('ws').WebSocket, boolean>()
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      ws.ping()
    }
  }, HEARTBEAT_MS)
  wss.on('close', () => clearInterval(heartbeat))

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    void (async () => {
      try {
        const cookies = parseCookieHeader(req.headers.cookie)
        const signed = cookies[SESSION_COOKIE]
        const token = signed ? unsignValue(signed, deps.config.cookieSecret) : null
        const user = token ? await deps.auth.resolveToken(token) : null
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          alive.set(ws, true)
          ws.on('pong', () => alive.set(ws, true))
          deps.hub.handleConnection(ws, user)
        })
      } catch (err) {
        console.error('[ws] upgrade failed:', err)
        socket.destroy()
      }
    })()
  })

  return wss
}
