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
export function attachWebSocket(
  server: Server,
  deps: { hub: Hub; auth: AuthService; config: ServerConfig },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

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
