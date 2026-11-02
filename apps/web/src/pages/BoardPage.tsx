import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Plug } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import type { BoardCard, BoardResponse, LiveMainInfo } from '@loom/shared'
import { ConnectAgentsButton } from '../components/ConnectAgents'
import { StateChip } from '../components/StateChip'
import { Avatar, CardSkeleton, EmptyState, ErrorState, PageHeader, SectionLabel, buttonVariants, cn } from '../components/primitives'
import { api } from '../lib/api'
import { identityColor } from '../lib/identity'
import { timeAgo, useNow } from '../lib/time'
import { wsClient } from '../lib/ws'
import { useProject } from './ProjectShell'
import { Stage } from './RoomView'

const LANES: Array<{ id: BoardCard['lane']; label: string; hint: string }> = [
  { id: 'needs-you', label: 'Needs you', hint: 'Conflicts, approvals, tests to try, questions' },
  { id: 'working', label: 'Agent working', hint: 'An agent is mid-turn' },
  { id: 'to-review', label: 'To review', hint: 'Has work that isn’t on main yet' },
  { id: 'idle', label: 'Idle', hint: 'Nothing changed yet' },
  { id: 'merged', label: 'Merged', hint: 'Its work is on main' },
]

const MAIN_LABEL: Record<BoardCard['main']['status'], { text: string; cls: string }> = {
  'up-to-date': { text: 'Up to date', cls: 'text-tertiary' },
  ready: { text: 'Ready to merge', cls: 'text-ok' },
  behind: { text: 'Behind main', cls: 'text-warn' },
  conflicts: { text: 'Conflicts with main', cls: 'text-danger' },
}

const fileLine = (path: string, symbols: string[]) => (symbols.length > 0 ? `${path} › ${symbols.slice(0, 2).join(', ')}${symbols.length > 2 ? '…' : ''}` : path)

/**
 * The Board: every live session in one view, by what it needs — plus where
 * agents' work overlaps (a test-merge says whether it would conflict), each
 * branch against main, laptop agents announcing their work over MCP, and
 * live main (everyone's work combined). Kept fresh as agents work.
 */
export function BoardPage() {
  const { projectId } = useProject()
  const now = useNow(15_000)
  const board = useQuery({
    queryKey: ['board', projectId],
    queryFn: () => api.get<BoardResponse>(`/api/projects/${projectId}/board`),
    refetchInterval: 6_000,
  })
  const live = useQuery({
    queryKey: ['live-main', projectId],
    queryFn: () => api.get<LiveMainInfo>(`/api/projects/${projectId}/live-main`),
    refetchInterval: 15_000,
  })
  // a commit or coordination event anywhere: refresh promptly
  useEffect(
    () =>
      wsClient.onMessage((m) => {
        if (m.t === 'project_update' && m.projectId === projectId) {
          void board.refetch()
          void live.refetch()
        }
      }),
    [projectId], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const data = board.data
  const counts = Object.fromEntries(LANES.map((l) => [l.id, data?.cards.filter((c) => c.lane === l.id).length ?? 0])) as Record<BoardCard['lane'], number>

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-8">
        <PageHeader
          title="Board"
          meta={
            data
              ? `${counts['needs-you']} need you · ${counts.working} agent${counts.working === 1 ? '' : 's'} working · ${counts['to-review']} to review · ${data.conflictsCaught} conflict${data.conflictsCaught === 1 ? '' : 's'} caught before merge`
              : 'Every session, by what it needs'
          }
          actions={<ConnectAgentsButton />}
        />

        {board.isLoading ? (
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <CardSkeleton lines={3} />
            <CardSkeleton lines={3} />
            <CardSkeleton lines={3} />
          </div>
        ) : board.isError || !data ? (
          <div className="mt-8">
            <ErrorState message="Couldn’t load the board. Check the server, then try again." onRetry={() => void board.refetch()} />
          </div>
        ) : (
          <>
            {data.cards.length === 0 && data.external.length === 0 ? (
              <EmptyState
                className="mt-8 border border-hairline-strong bg-surface"
                title="No live work right now."
                hint="Start a session from the dashboard, or connect your own coding agent so its work shows up here."
                action={
                  <Link to={`/p/${projectId}`} className={buttonVariants({ variant: 'primary' })}>
                    Go to the dashboard
                  </Link>
                }
              />
            ) : (
              <div className="mt-8 grid gap-px overflow-x-auto border border-hairline-strong bg-hairline-strong md:grid-cols-5">
                {LANES.map((lane) => (
                  <section key={lane.id} aria-label={lane.label} className="min-w-[220px] bg-canvas">
                    <header className="sticky top-0 flex items-baseline gap-2 border-b-2 border-hairline-strong bg-canvas px-3 py-2">
                      <h2 className={cn('telemetry', lane.id === 'needs-you' && counts['needs-you'] > 0 ? 'text-signal-300' : 'text-primary')}>{lane.label}</h2>
                      <span className="tnum telemetry text-tertiary">{counts[lane.id]}</span>
                    </header>
                    <p className="px-3 pt-2 text-micro normal-case tracking-normal text-tertiary">{lane.hint}</p>
                    <ol className="space-y-2 p-2">
                      {data.cards
                        .filter((c) => c.lane === lane.id)
                        .map((c) => (
                          <li key={c.sessionId}>
                            <Card card={c} projectId={projectId} now={now} />
                          </li>
                        ))}
                    </ol>
                  </section>
                ))}
              </div>
            )}

            {data.external.length > 0 && (
              <>
                <SectionLabel className="mt-10">Laptop agents</SectionLabel>
                <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {data.external.map((x) => (
                    <li key={x.key} className="border border-hairline-strong bg-surface p-3">
                      <div className="flex items-center gap-2">
                        <Plug size={13} strokeWidth={1.75} aria-hidden />
                        <span className="text-ui font-semibold text-primary">{x.userName}</span>
                        <span className="min-w-0 truncate font-mono text-code-sm text-tertiary">{x.branchName}</span>
                        <span className="telemetry ml-auto shrink-0 text-tertiary">{timeAgo(x.since, now)}</span>
                      </div>
                      {x.title && <div className="mt-1 text-small text-secondary">{x.title}</div>}
                      <ul className="mt-1.5 space-y-0.5">
                        {x.files.slice(0, 4).map((f) => (
                          <li key={f.path} className="truncate font-mono text-code-sm text-primary">
                            {fileLine(f.path, f.symbols)}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        <LiveMainPanel projectId={projectId} live={live.data ?? null} loading={live.isLoading} />
      </div>
    </div>
  )
}

function Card({ card, projectId, now }: { card: BoardCard; projectId: string; now: number }) {
  const main = MAIN_LABEL[card.main.status]
  const conflicting = card.overlaps.filter((o) => o.conflicts.length > 0)
  const clean = card.overlaps.filter((o) => o.conflicts.length === 0)
  return (
    <Link
      to={`/p/${projectId}/s/${card.sessionId}`}
      className="block border border-hairline-strong bg-surface p-3 transition-[box-shadow,transform] duration-fast hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_0_var(--text-primary)] motion-reduce:hover:translate-x-0 motion-reduce:hover:translate-y-0"
    >
      <div className="flex items-center gap-2">
        <Avatar name={card.driver.name} color={card.driver.color} size="xs" />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{card.title}</span>
      </div>
      <div className="mt-1 font-mono text-code-sm text-tertiary">{card.branchName.replace(/^session\//, '')}</div>
      <div className="mt-2">
        <StateChip compact={false} state={card.state.state} detail={card.state.detail} />
      </div>
      <div className={cn('telemetry mt-2', main.cls)}>
        {main.text}
        {card.main.ahead > 0 ? ` · ${card.main.ahead} ahead` : ''}
        {card.main.behind > 0 ? ` · ${card.main.behind} behind` : ''}
      </div>
      {card.main.conflicts.length > 0 && (
        <div className="mt-1 text-small text-danger">{card.main.conflicts.map((c) => fileLine(c.path, c.symbols)).join('; ')}</div>
      )}
      {conflicting.map((o) => (
        <div key={o.withName + o.withTitle} className="mt-2 border-l-2 border-signal-500 pl-2 text-small">
          <span className="font-semibold text-danger">Conflicts with {o.withName}</span>
          <span className="block font-mono text-code-sm text-primary">{o.conflicts.map((c) => fileLine(c.path, c.symbols)).join('; ')}</span>
        </div>
      ))}
      {clean.length > 0 && (
        <div className="mt-2 text-small text-secondary">
          Also in {clean.flatMap((o) => o.files).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(', ')} with {clean.map((o) => o.withName).join(', ')} — merges cleanly
        </div>
      )}
      {card.files.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-hairline pt-2">
          {card.files.slice(0, 3).map((f) => (
            <li key={f.path} className="truncate font-mono text-code-sm text-secondary">
              {fileLine(f.path, f.symbols)}
            </li>
          ))}
          {card.files.length > 3 && <li className="telemetry text-tertiary">+{card.files.length - 3} more</li>}
        </ul>
      )}
      {card.lastEventAt && <div className="telemetry mt-2 text-tertiary">{timeAgo(card.lastEventAt, now)}</div>}
    </Link>
  )
}

function LiveMainPanel({ projectId, live, loading }: { projectId: string; live: LiveMainInfo | null; loading: boolean }) {
  return (
    <section aria-label="Live main" className="mt-12">
      <SectionLabel>Live main — everyone&rsquo;s work, combined</SectionLabel>
      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="border border-hairline-strong bg-surface">
          <Stage target={{ live: projectId }} reloadKey={live?.builtAt ?? 0} title="Live main preview" testers={[]} />
          <div className="flex items-center gap-2 border-t border-hairline-strong px-3 py-2">
            {live?.checks ? (
              <span
                className={cn(
                  'telemetry px-1.5 font-bold text-on-accent',
                  live.checks.status === 'passed' ? 'bg-ok' : live.checks.status === 'warned' ? 'bg-warn' : 'bg-signal-500',
                )}
              >
                {live.checks.status === 'passed' ? 'Checks pass' : live.checks.status === 'warned' ? 'Checks warn' : 'Checks fail'}
              </span>
            ) : (
              <span className="telemetry text-tertiary">{loading ? 'Building…' : 'No checks yet'}</span>
            )}
            <span className="text-small text-secondary">main {live?.mainSha.slice(0, 7) ?? '…'} + the work below</span>
            <a href={`/preview/live/${projectId}/`} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'ml-auto')}>
              Open live main <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
        </div>
        <ol className="space-y-2">
          {(live?.entries ?? []).map((e) => (
            <li key={e.key} className="flex gap-3 border border-hairline-strong bg-surface p-3">
              <span aria-hidden className="mt-1 h-3 w-3 shrink-0 border border-hairline-strong" style={{ background: identityColor(e.userColor) }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-ui font-semibold text-primary">{e.userName}</span>
                  <span className="min-w-0 truncate text-small text-secondary">{e.title}</span>
                </div>
                {e.status === 'in-live-main' ? (
                  <div className="telemetry mt-1 text-ok">In live main</div>
                ) : e.status === 'doesnt-fit' ? (
                  <div className="mt-1 text-small">
                    <span className="telemetry text-danger">Doesn&rsquo;t fit yet</span>
                    <span className="block font-mono text-code-sm text-primary">{e.conflicts.map((c) => fileLine(c.path, c.symbols)).join('; ')}</span>
                    {e.collidesWith.length > 0 && <span className="block text-tertiary">Collides with {e.collidesWith.join(', ')}&rsquo;s work — the newer work adapts.</span>}
                  </div>
                ) : (
                  <div className="telemetry mt-1 text-tertiary">Nothing to combine yet</div>
                )}
              </div>
              <Link to={`/p/${projectId}/s/${e.sessionId}`} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start')} aria-label={`Open ${e.title}`}>
                Open
              </Link>
            </li>
          ))}
          {live && live.entries.length === 0 && <li className="text-small text-tertiary">No live sessions — live main is just main.</li>}
        </ol>
      </div>
    </section>
  )
}
