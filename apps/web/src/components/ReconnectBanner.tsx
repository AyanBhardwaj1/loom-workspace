import { useEffect, useRef, useState } from 'react'
import { StatusDot } from './primitives'
import { wsClient, type ConnectionStatus } from '../lib/ws'

/**
 * §7.8 — a slim non-blocking banner under the top bar. Shows while the socket
 * is down ("Reconnecting — events will catch up"), then a 2s success flash
 * ("Caught up") when it returns. Never a modal; never blocks reading.
 */
export function ReconnectBanner() {
  const [status, setStatus] = useState<ConnectionStatus>(() => wsClient.getStatus())
  const [flash, setFlash] = useState(false)
  const everDown = useRef(false)

  useEffect(() => {
    return wsClient.onStatus((next) => {
      setStatus(next)
      if (next === 'reconnecting') everDown.current = true
      if (next === 'open' && everDown.current) {
        setFlash(true)
        const t = setTimeout(() => setFlash(false), 2000)
        return () => clearTimeout(t)
      }
    })
  }, [])

  // the live region stays mounted; only its content changes, so screen readers announce it
  const tone = status === 'reconnecting' ? 'warn' : flash ? 'ok' : null
  return (
    <div role="status" aria-live="polite">
      {tone && (
        <div
          className={
            tone === 'warn'
              ? 'flex h-8 shrink-0 items-center justify-center gap-2 border-b border-hairline bg-warn-fill text-small text-warn'
              : 'flex h-8 shrink-0 items-center justify-center gap-2 border-b border-hairline bg-ok-fill text-small text-ok'
          }
        >
          <StatusDot tone={tone} />
          {tone === 'warn' ? 'Reconnecting… events will catch up' : 'Caught up'}
        </div>
      )}
    </div>
  )
}
