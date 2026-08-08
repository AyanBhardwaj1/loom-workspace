import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChatLog } from '../components/ChatLog'
import { Composer } from '../components/Composer'
import { SpectatorSidebar } from '../components/SpectatorSidebar'
import { AgentStatusIndicator, Avatar, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { useAuth } from '../state/auth'
import { useSessionStream } from '../state/useSessionStream'
import { useProject } from './ProjectShell'

export function SessionView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { projectId, feed } = useProject()
  const { user } = useAuth()
  const navigate = useNavigate()
  const stream = useSessionStream(sessionId ?? null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [forking, setForking] = useState(false)
  const [ending, setEnding] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  // presence: tell the hub which session we're actually looking at
  useEffect(() => {
    if (!sessionId) return
    wsClient.setViewing(sessionId)
    return () => wsClient.setViewing(null)
  }, [sessionId])

  // surface rejected messages and other server-side errors instead of eating them
  useEffect(() => {
    const off = wsClient.onMessage((msg) => {
      if (msg.t === 'error') {
        setServerError(msg.message)
        const timer = setTimeout(() => setServerError(null), 6000)
        return () => clearTimeout(timer)
      }
    })
    return off
  }, [])

  const meta = stream.detail
  const session = meta?.session
  const isDriver = Boolean(session && user && session.driverUserId === user.id)
  const isEnded = session?.status === 'ended'
  const watcherCount = useMemo(
    () => feed.presence.filter((p) => p.viewing === sessionId).length,
    [feed.presence, sessionId],
  )

  const fork = async (atEventId?: string) => {
    if (!sessionId || forking) return
    setForking(true)
    try {
      const res = await api.post<{ session: { id: string } }>(`/api/sessions/${sessionId}/fork`, { atEventId })
      navigate(`/p/${projectId}/s/${res.session.id}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Fork failed')
    } finally {
      setForking(false)
    }
  }

  const endSession = async () => {
    if (!sessionId || ending) return
    if (!confirm('End this session? The branch and full transcript stay available.')) return
    setEnding(true)
    try {
      await api.post(`/api/sessions/${sessionId}/end`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not end the session')
    } finally {
      setEnding(false)
    }
  }

  if (stream.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="h-7 w-7" />
      </div>
    )
  }

  if (stream.error || !meta || !session) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-300">
        <div>{stream.error ?? 'Session not found'}</div>
        <Link className="btn-secondary" to={`/p/${projectId}`}>
          Back to dashboard
        </Link>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* header */}
        <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900/60 px-5 py-3">
          <Link
            to={`/p/${projectId}/m/${session.moduleId}`}
            className="flex items-center gap-2 text-sm text-ink-300 hover:text-accent"
            title="Back to module"
          >
            <span className="text-lg">{meta.moduleEmoji}</span>
            <span className="hidden font-medium sm:inline">{meta.moduleName}</span>
          </Link>
          <span className="text-ink-500">/</span>
          <span className="truncate text-sm font-medium">{session.title}</span>
          {session.parentSessionId && (
            <Link
              to={`/p/${projectId}/s/${session.parentSessionId}`}
              className="chip text-[10px] hover:border-accent"
              title="Open the session this was forked from"
            >
              ⑂ forked
            </Link>
          )}
          <div className="ml-auto flex items-center gap-3">
            {isEnded ? (
              <span className="chip">ended</span>
            ) : (
              <AgentStatusIndicator status={stream.agentStatus} />
            )}
            {watcherCount > 0 && (
              <span className="text-xs text-ink-300" title="People viewing this session right now">
                👁 {watcherCount} watching
              </span>
            )}
            <div className="flex items-center gap-1.5" title={`${session.driverName} is driving`}>
              <Avatar name={session.driverName} color={session.driverAvatarColor} size="sm" pulsing={!isEnded && stream.agentStatus !== 'idle'} />
              <span className="hidden text-xs text-ink-200 md:inline">{session.driverName}</span>
            </div>
            <span className="mono-chip hidden lg:inline-flex" title="This session's git branch">
              {session.branchName}
            </span>
            {isDriver && !isEnded && (
              <button onClick={() => void endSession()} disabled={ending} className="btn-ghost text-xs text-ink-400">
                End
              </button>
            )}
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="btn-ghost text-xs"
              title="Toggle the spectate sidebar"
            >
              👁 {sidebarOpen ? 'Hide' : 'Spectate'}
            </button>
          </div>
        </header>

        {isEnded && (
          <div className="border-b border-ink-700 bg-ink-850 px-5 py-2 text-center text-xs text-ink-300">
            This session has ended — you're reading its transcript. Fork it to keep building from here.
          </div>
        )}
        {serverError && (
          <div className="border-b border-red-900/60 bg-red-950/30 px-5 py-2 text-center text-xs text-red-300">
            {serverError}
          </div>
        )}

        {/* chat */}
        <ChatLog
          events={stream.events}
          streamingText={stream.streamingText}
          agentStatus={isEnded ? 'idle' : stream.agentStatus}
          driverName={session.driverName}
          driverColor={session.driverAvatarColor}
          onFork={(eventId) => void fork(eventId)}
          emptyHint={
            isDriver
              ? 'Tell the agent what to build — it reads and writes this project’s real code.'
              : 'Nothing here yet.'
          }
        />

        {/* composer / spectator bar */}
        {isDriver && !isEnded ? (
          <Composer sessionId={session.id} agentStatus={stream.agentStatus} />
        ) : (
          <div className="border-t border-ink-700 bg-ink-900/80 px-5 py-3.5">
            <div className="flex items-center gap-3">
              <div className="text-xs text-ink-300">
                {isEnded
                  ? 'Session ended.'
                  : `You're spectating — ${session.driverName} is driving.`}{' '}
                Fork to get {isEnded ? 'its' : 'their'} full conversation and code as your own session.
              </div>
              <button onClick={() => void fork()} disabled={forking} className="btn-primary ml-auto shrink-0 text-xs">
                {forking ? 'Forking…' : '⑂ Fork & continue from here'}
              </button>
            </div>
          </div>
        )}
      </div>

      {sidebarOpen && sessionId && (
        <div className="hidden md:flex">
          <SpectatorSidebar projectId={projectId} currentSessionId={sessionId} onClose={() => setSidebarOpen(false)} />
        </div>
      )}
    </div>
  )
}
