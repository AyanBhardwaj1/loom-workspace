import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { wsClient } from '../lib/ws'

/**
 * F9 — global listener: when a driver offers YOU the wheel, a toast prompts
 * Accept / Decline anywhere in the app. Accepting jumps into the session.
 */
export function HandoffListener() {
  const navigate = useNavigate()

  useEffect(() => {
    return wsClient.onMessage((msg) => {
      if (msg.t !== 'handoff_request') return
      const { sessionId, sessionTitle, fromName } = msg
      toast(`${fromName} is passing you the wheel`, {
        description: `"${sessionTitle}" — accept to start driving.`,
        duration: 30_000,
        action: {
          label: 'Accept',
          onClick: async () => {
            wsClient.handoffResponse(sessionId, true)
            // the session detail flips driver via the status event; just go there
            const res = await fetch(`/api/sessions/${sessionId}`).then((r) => (r.ok ? r.json() : null))
            const projectId = res?.session?.projectId
            if (projectId) navigate(`/p/${projectId}/s/${sessionId}`)
          },
        },
        cancel: {
          label: 'Decline',
          onClick: () => wsClient.handoffResponse(sessionId, false),
        },
      })
    })
  }, [navigate])

  return null
}
