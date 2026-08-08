import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { SessionSummary } from '@loom/shared'
import { AgentStatusIndicator, Avatar, CardSkeleton, EmptyState, StatusPill } from '../components/ui'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'
import { useAuth } from '../state/auth'
import { useProject } from './ProjectShell'

type SessionWithCount = SessionSummary & { changeCount: number }

export function ModuleView() {
  const { moduleId } = useParams<{ moduleId: string }>()
  const { projectId, detailQuery, feed } = useProject()
  const { user } = useAuth()
  const navigate = useNavigate()
  const now = useNow(10_000)
  const [starting, setStarting] = useState(false)
  const [forkingId, setForkingId] = useState<string | null>(null)

  const module = detailQuery.data?.modules.find((m) => m.id === moduleId)

  const sessionsQuery = useQuery({
    queryKey: ['module-sessions', moduleId],
    queryFn: () => api.get<{ sessions: SessionWithCount[] }>(`/api/modules/${moduleId}/sessions`),
    enabled: Boolean(moduleId),
    refetchInterval: 12_000,
  })

  if (!module) {
    return (
      <div className="p-8">
        <EmptyState emoji="🤔" title="Module not found" action={<Link className="btn-secondary" to={`/p/${projectId}`}>Back to dashboard</Link>} />
      </div>
    )
  }

  const startSession = async () => {
    if (starting) return
    setStarting(true)
    try {
      const res = await api.post<{ session: SessionSummary }>(`/api/modules/${module.id}/sessions`, {})
      navigate(`/p/${projectId}/s/${res.session.id}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not start a session')
      setStarting(false)
    }
  }

  const fork = async (sessionId: string) => {
    if (forkingId) return
    setForkingId(sessionId)
    try {
      const res = await api.post<{ session: SessionSummary }>(`/api/sessions/${sessionId}/fork`, {})
      navigate(`/p/${projectId}/s/${res.session.id}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Fork failed')
      setForkingId(null)
    }
  }

  const sessions = sessionsQuery.data?.sessions ?? []
  const active = sessions.filter((s) => s.status !== 'ended')
  const past = sessions.filter((s) => s.status === 'ended')

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-8 py-7">
      <Link to={`/p/${projectId}`} className="text-xs text-ink-400 hover:text-accent">
        ← Back to dashboard
      </Link>
      <header className="mb-6 mt-2 flex items-center gap-4">
        <span className="text-4xl">{module.emoji}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight">{module.name}</h1>
            <StatusPill status={module.status} />
          </div>
          <p className="mt-0.5 text-sm text-ink-300">{module.description}</p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => void startSession()} disabled={starting}>
          {starting ? 'Cutting branch…' : '▶ Start session'}
        </button>
      </header>

      {sessionsQuery.isLoading ? (
        <div className="space-y-3">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          emoji="🎬"
          title="No sessions yet in this module"
          hint="Start a session to open a chat with the coding agent — every prompt, file edit and commit will be visible live to your team, and forkable."
          action={
            <button className="btn-primary" onClick={() => void startSession()} disabled={starting}>
              {starting ? 'Cutting branch…' : 'Start the first session'}
            </button>
          }
        />
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <section>
              <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-ink-300">Live now</h2>
              <div className="space-y-2.5">
                {active.map((s) => {
                  const gist = feed.activityByModule.get(module.id)
                  const isMine = s.driverUserId === user?.id
                  return (
                    <div key={s.id} className="card flex items-center gap-4 p-4">
                      <Avatar name={s.driverName} color={s.driverAvatarColor} pulsing={s.status === 'active'} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{s.title}</span>
                          {isMine && <span className="chip text-[10px]">you</span>}
                          {s.parentSessionId && <span className="chip text-[10px]">⑂ fork</span>}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-ink-300">
                          {s.driverName}
                          {gist && gist.sessionId === s.id ? ` · ${gist.gist}` : ''}
                        </div>
                      </div>
                      <div className="hidden sm:block">
                        <AgentStatusIndicator status={s.status === 'active' ? 'running_tools' : 'idle'} />
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {isMine ? (
                          <Link to={`/p/${projectId}/s/${s.id}`} className="btn-primary text-xs">
                            Continue
                          </Link>
                        ) : (
                          <>
                            <Link to={`/p/${projectId}/s/${s.id}`} className="btn-secondary text-xs">
                              👁 Watch
                            </Link>
                            <button
                              onClick={() => void fork(s.id)}
                              disabled={forkingId !== null}
                              className="btn-secondary text-xs"
                            >
                              {forkingId === s.id ? 'Forking…' : '⑂ Fork & continue'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section>
              <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-ink-300">Past sessions</h2>
              <div className="space-y-2">
                {past.map((s) => (
                  <Link
                    key={s.id}
                    to={`/p/${projectId}/s/${s.id}`}
                    className="card flex items-center gap-4 p-3.5 transition-colors hover:border-ink-500"
                  >
                    <Avatar name={s.driverName} color={s.driverAvatarColor} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm">{s.title}</span>
                        {s.parentSessionId && <span className="chip text-[10px]">⑂ fork</span>}
                      </div>
                      <div className="text-[11px] text-ink-400">
                        {s.changeCount} change{s.changeCount === 1 ? '' : 's'} · ended {timeAgo(s.lastEventAt, now)}
                      </div>
                    </div>
                    <span className="text-xs text-ink-400">view transcript →</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
