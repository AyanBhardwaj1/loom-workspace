import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Eye, GitFork, Play } from 'lucide-react'
import type { SessionSummary } from '@loom/shared'
import { formatCost, formatTokens } from '@loom/shared'
import {
  Avatar,
  AvatarStack,
  Button,
  CardSkeleton,
  EmptyState,
  LivePill,
  Pill,
  SectionLabel,
  StatusDot,
  buttonVariants,
  cn,
} from '../components/primitives'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'
import { useAuth } from '../state/auth'
import { useProject } from './ProjectShell'

type SessionWithCount = SessionSummary & { changeCount: number; tokens: number; costUsd: number }

const STATUS_TONE = { idea: 'neutral', building: 'warn', stable: 'ok' } as const
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function ModuleView() {
  const { moduleId } = useParams<{ moduleId: string }>()
  const { projectId, detailQuery, feed } = useProject()
  const { user } = useAuth()
  const navigate = useNavigate()
  const now = useNow(10_000)
  const [starting, setStarting] = useState(false)
  const [forkingId, setForkingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

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
          hint="It may have been removed, or the link is from another project."
          action={
            <Link to={`/p/${projectId}`} className={buttonVariants()}>
              Back to dashboard
            </Link>
          }
        />
      </div>
    )
  }

  const startSession = async () => {
    if (starting) return
    setStarting(true)
    setActionError(null)
    try {
      const res = await api.post<{ session: SessionSummary }>(`/api/modules/${module.id}/sessions`, {})
      navigate(`/p/${projectId}/s/${res.session.id}`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not start a session. Try again.')
      setStarting(false)
    }
  }

  const fork = async (sessionId: string) => {
    if (forkingId) return
    setForkingId(sessionId)
    setActionError(null)
    try {
      const res = await api.post<{ session: SessionSummary }>(`/api/sessions/${sessionId}/fork`, {})
      navigate(`/p/${projectId}/s/${res.session.id}`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The fork failed. Try again.')
      setForkingId(null)
    }
  }

  const sessions = sessionsQuery.data?.sessions ?? []
  const active = sessions.filter((s) => s.status !== 'ended')
  const past = sessions.filter((s) => s.status === 'ended')
  const moduleTokens = sessions.reduce((n, s) => n + (s.tokens ?? 0), 0)
  const moduleCost = sessions.reduce((n, s) => n + (s.costUsd ?? 0), 0)
  const changes = sessions.reduce((n, s) => n + (s.changeCount ?? 0), 0)
  const drivers = [...new Map(sessions.map((s) => [s.driverUserId, { name: s.driverName, avatarColor: s.driverAvatarColor }])).values()]
  const lastActive = sessions.map((s) => s.lastEventAt).filter(Boolean).sort().at(-1) ?? null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-7 sm:px-8">
        <Link
          to={`/p/${projectId}`}
          className="inline-flex items-center gap-1 text-small text-tertiary transition-colors duration-micro hover:text-secondary"
        >
          <ArrowLeft size={13} strokeWidth={1.5} aria-hidden />
          Dashboard
        </Link>

        <header className="mb-8 mt-3 flex flex-wrap items-start gap-4">
          <span
            aria-hidden
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-hairline bg-inset text-h2"
          >
            {module.emoji}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-balance text-display text-primary">{module.name}</h1>
              <Pill tone={STATUS_TONE[module.status]}>{module.status}</Pill>
            </div>
            <p className="mt-1 max-w-[65ch] text-ui text-secondary">{module.description}</p>
          </div>
          <Button variant="primary" size="lg" onClick={() => void startSession()} disabled={starting}>
            <Play size={14} strokeWidth={1.5} aria-hidden />
            {starting ? 'Cutting branch…' : 'Start session'}
          </Button>
        </header>

        {actionError && (
          <div role="alert" className="mb-6 rounded-lg border border-danger-border bg-danger-fill px-4 py-3 text-ui text-danger">
            {actionError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0">
            {sessionsQuery.isLoading ? (
              <div className="space-y-3">
                <CardSkeleton lines={2} />
                <CardSkeleton lines={2} />
              </div>
            ) : sessions.length === 0 ? (
              <EmptyState
                className="rounded-lg border border-dashed border-hairline"
                title="No sessions yet in this module"
                hint="Start a session to open a chat with the coding agent — every prompt, edit and commit is live for your team, and forkable."
                action={
                  <Button variant="primary" onClick={() => void startSession()} disabled={starting}>
                    {starting ? 'Cutting branch…' : 'Start the first session'}
                  </Button>
                }
              />
            ) : (
              <div className="space-y-8">
                <section>
                  <SectionLabel className="mb-2">
                    <StatusDot tone={active.length > 0 ? 'ok' : 'idle'} /> Live now
                  </SectionLabel>
                  {active.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-hairline px-4 py-5 text-ui text-tertiary">
                      Nobody is building here right now. Start a session — teammates can watch it the moment it begins.
                    </p>
                  ) : (
                    <ul className="overflow-hidden rounded-lg border border-hairline">
                      {active.map((s, i) => {
                        const gist = feed.activityByModule.get(module.id)
                        const isMine = s.driverUserId === user?.id
                        return (
                          <li
                            key={s.id}
                            className={cn(
                              'flex flex-wrap items-center gap-3 bg-surface px-4 py-3 sm:flex-nowrap',
                              i > 0 && 'border-t border-hairline',
                            )}
                          >
                            <Avatar name={s.driverName} color={s.driverAvatarColor} size="lg" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-ui font-medium text-primary">{s.title}</span>
                                {s.status === 'active' && <LivePill />}
                                {isMine && <Pill>you</Pill>}
                                {s.parentSessionId && (
                                  <Pill tone="accent">
                                    <GitFork size={10} strokeWidth={1.5} aria-hidden /> fork
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
                                <Link to={`/p/${projectId}/s/${s.id}`} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                                  Continue
                                </Link>
                              ) : (
                                <>
                                  <Link to={`/p/${projectId}/s/${s.id}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                                    <Eye size={14} strokeWidth={1.5} aria-hidden />
                                    Watch
                                  </Link>
                                  <Button variant="ghost" size="sm" onClick={() => void fork(s.id)} disabled={forkingId !== null}>
                                    <GitFork size={14} strokeWidth={1.5} aria-hidden />
                                    {forkingId === s.id ? 'Forking…' : 'Fork & continue'}
                                  </Button>
                                </>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>

                <section>
                  <SectionLabel className="mb-2">Past sessions</SectionLabel>
                  {past.length === 0 ? (
                    <p className="text-small text-tertiary">
                      Ended sessions land here with their transcript, commits and cost — ready to replay or fork.
                    </p>
                  ) : (
                    <ul className="overflow-hidden rounded-lg border border-hairline">
                      {past.map((s, i) => (
                        <li key={s.id} className={cn(i > 0 && 'border-t border-hairline')}>
                          <Link
                            to={`/p/${projectId}/s/${s.id}`}
                            className="flex items-center gap-3 bg-surface px-4 py-2.5 transition-colors duration-micro hover:bg-raised"
                          >
                            <Avatar name={s.driverName} color={s.driverAvatarColor} size="sm" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-ui text-primary">{s.title}</span>
                                {s.parentSessionId && (
                                  <Pill tone="accent">
                                    <GitFork size={10} strokeWidth={1.5} aria-hidden /> fork
                                  </Pill>
                                )}
                              </div>
                              <div className="tnum mt-0.5 text-small text-tertiary">
                                {plural(s.changeCount, 'change')}
                                {s.tokens > 0 && ` · ${formatTokens(s.tokens)} tok${s.costUsd > 0 ? ` · ${formatCost(s.costUsd)}` : ''}`}
                                {' · ended '}
                                {timeAgo(s.lastEventAt, now)}
                              </div>
                            </div>
                            <span className="shrink-0 text-small text-tertiary">Transcript →</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </div>

          <aside aria-label="Module at a glance" className="h-fit rounded-lg border border-hairline bg-surface p-4">
            <SectionLabel>At a glance</SectionLabel>
            <dl className="mt-3 space-y-3 text-ui">
              <Stat label="Sessions" value={`${sessions.length}${active.length > 0 ? ` · ${active.length} live` : ''}`} />
              <Stat label="Changes committed" value={String(changes)} />
              <Stat
                label="AI usage"
                value={moduleTokens > 0 ? `${formatTokens(moduleTokens)} tok${moduleCost > 0 ? ` · ${formatCost(moduleCost)}` : ''}` : '—'}
              />
              <Stat label="Last activity" value={lastActive ? timeAgo(lastActive, now) : '—'} />
            </dl>
            {drivers.length > 0 && (
              <div className="mt-4 border-t border-hairline pt-3">
                <div className="mb-2 text-small text-tertiary">Built by</div>
                <AvatarStack users={drivers} size="sm" />
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-small text-tertiary">{label}</dt>
      <dd className="tnum truncate font-mono text-code text-primary">{value}</dd>
    </div>
  )
}
