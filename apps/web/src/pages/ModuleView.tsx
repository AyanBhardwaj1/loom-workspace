import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Eye, GitFork, Play } from 'lucide-react'
import type { SessionSummary } from '@loom/shared'
import { formatCost, formatTokens } from '@loom/shared'
import { Avatar, Button, CardSkeleton, EmptyState, LivePill, Pill, StatusDot, cn } from '../components/primitives'
import { Tooltip } from '../components/overlay'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'
import { useAuth } from '../state/auth'
import { useProject } from './ProjectShell'

type SessionWithCount = SessionSummary & { changeCount: number; tokens: number; costUsd: number }

const STATUS_TONE = { idea: 'neutral', building: 'warn', stable: 'ok' } as const

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
        <EmptyState
          title="Module not found"
          action={
            <Link to={`/p/${projectId}`}>
              <Button>Back to dashboard</Button>
            </Link>
          }
        />
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
  const moduleTokens = sessions.reduce((n, s) => n + (s.tokens ?? 0), 0)
  const moduleCost = sessions.reduce((n, s) => n + (s.costUsd ?? 0), 0)

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-8 py-7">
      <Link
        to={`/p/${projectId}`}
        className="inline-flex items-center gap-1 text-small text-tertiary transition-colors duration-micro hover:text-secondary"
      >
        <ArrowLeft size={13} strokeWidth={1.5} />
        Dashboard
      </Link>
      <header className="mb-6 mt-3 flex items-start gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-hairline bg-inset text-h3">
          {module.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-h2 text-primary">{module.name}</h1>
            <Pill tone={STATUS_TONE[module.status]}>{module.status}</Pill>
          </div>
          <p className="mt-0.5 text-ui text-secondary">{module.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {moduleTokens > 0 && (
            <Tooltip content="Total AI usage across this module's sessions">
              <span className="tnum font-mono text-small text-tertiary">
                {formatTokens(moduleTokens)} tok{moduleCost > 0 ? ` · ${formatCost(moduleCost)}` : ''}
              </span>
            </Tooltip>
          )}
          <Button variant="primary" onClick={() => void startSession()} disabled={starting}>
            <Play size={14} strokeWidth={1.5} />
            {starting ? 'Cutting branch…' : 'Start session'}
          </Button>
        </div>
      </header>

      {sessionsQuery.isLoading ? (
        <div className="space-y-3">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          title="No sessions yet in this module"
          hint="Start a session to open a chat with the coding agent — every prompt, edit and commit is live for your team, and forkable."
          action={
            <Button variant="primary" onClick={() => void startSession()} disabled={starting}>
              {starting ? 'Cutting branch…' : 'Start the first session'}
            </Button>
          }
        />
      ) : (
        <div className="space-y-7">
          {active.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-micro uppercase tracking-[0.08em] text-tertiary">
                <StatusDot tone="ok" /> Live now
              </h2>
              <div className="overflow-hidden rounded-lg border border-hairline">
                {active.map((s, i) => {
                  const gist = feed.activityByModule.get(module.id)
                  const isMine = s.driverUserId === user?.id
                  return (
                    <div
                      key={s.id}
                      className={cn('flex items-center gap-3 bg-surface px-4 py-3', i > 0 && 'border-t border-hairline')}
                    >
                      <Avatar name={s.driverName} color={s.driverAvatarColor} size="lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-ui font-medium text-primary">{s.title}</span>
                          {s.status === 'active' && <LivePill />}
                          {isMine && <Pill>you</Pill>}
                          {s.parentSessionId && (
                            <Pill tone="accent">
                              <GitFork size={10} strokeWidth={1.5} /> fork
                            </Pill>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-small text-secondary">
                          {s.driverName}
                          {gist && gist.sessionId === s.id ? ` · ${gist.gist}` : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {isMine ? (
                          <Link to={`/p/${projectId}/s/${s.id}`}>
                            <Button variant="primary" size="sm">
                              Continue
                            </Button>
                          </Link>
                        ) : (
                          <>
                            <Link to={`/p/${projectId}/s/${s.id}`}>
                              <Button variant="ghost" size="sm">
                                <Eye size={14} strokeWidth={1.5} />
                                Watch
                              </Button>
                            </Link>
                            <Button variant="ghost" size="sm" onClick={() => void fork(s.id)} disabled={forkingId !== null}>
                              <GitFork size={14} strokeWidth={1.5} />
                              {forkingId === s.id ? 'Forking…' : 'Fork & continue'}
                            </Button>
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
              <h2 className="mb-2 text-micro uppercase tracking-[0.08em] text-tertiary">Past sessions</h2>
              <div className="overflow-hidden rounded-lg border border-hairline">
                {past.map((s, i) => (
                  <Link
                    key={s.id}
                    to={`/p/${projectId}/s/${s.id}`}
                    className={cn(
                      'flex items-center gap-3 bg-surface px-4 py-2.5 transition-colors duration-micro hover:bg-raised',
                      i > 0 && 'border-t border-hairline',
                    )}
                  >
                    <Avatar name={s.driverName} color={s.driverAvatarColor} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-ui text-primary">{s.title}</span>
                        {s.parentSessionId && (
                          <Pill tone="accent">
                            <GitFork size={10} strokeWidth={1.5} /> fork
                          </Pill>
                        )}
                      </div>
                      <div className="tnum mt-0.5 text-small text-tertiary">
                        {s.changeCount} change{s.changeCount === 1 ? '' : 's'}
                        {s.tokens > 0 && ` · ${formatTokens(s.tokens)} tok${s.costUsd > 0 ? ` · ${formatCost(s.costUsd)}` : ''}`}
                        {' · ended '}
                        {timeAgo(s.lastEventAt, now)}
                      </div>
                    </div>
                    <span className="text-small text-tertiary">transcript →</span>
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
