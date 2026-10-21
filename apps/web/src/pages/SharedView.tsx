import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { SessionDetail } from '@loom/shared'
import { ChatLog } from '../components/ChatLog'
import { Wordmark } from '../components/Wordmark'
import { Pill, Spinner } from '../components/primitives'
import { api } from '../lib/api'

/**
 * F11 — the read-only share page: the token in the URL is the credential.
 * No composer, no fork, no live subscription — a clean handoff artifact.
 */
export function SharedView() {
  const { token } = useParams<{ token: string }>()
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)
    void api
      .get<SessionDetail>(`/api/shared/${token}`)
      .then((d) => alive && setDetail(d))
      .catch((err) => alive && setError(err instanceof Error ? err.message : 'This link was revoked or never existed.'))
    return () => {
      alive = false
    }
  }, [token])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Wordmark height={22} className="text-primary opacity-60" />
        <div className="text-ui text-secondary">{error}</div>
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  const s = detail.session
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-4">
        <Wordmark height={16} className="text-primary" />
        <Pill tone="accent">Shared</Pill>
        <div className="min-w-0">
          <h1 className="truncate text-ui font-medium text-primary">{s.title}</h1>
          <div className="truncate text-small text-tertiary">
            {detail.moduleName} · driven by {s.driverName} · read-only
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto flex min-h-0 w-full max-w-[860px] flex-1 flex-col">
        <ChatLog
          events={detail.events}
          streamingText=""
          agentStatus="idle"
          driverName={s.driverName}
          driverColor={s.driverAvatarColor}
          ended={s.status === 'ended'}
          emptyHint="Nothing was recorded in this session."
        />
      </main>
    </div>
  )
}
