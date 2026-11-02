import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { deriveSessionState, type SessionDetail, type SessionEvent, type SessionSummary } from '@loom/shared'
import { StateChip } from '../components/StateChip'
import { latestOf } from '../components/eventStream'
import { Avatar, EmptyState, PageHeader, SectionLabel, buttonVariants, cn } from '../components/primitives'
import { api } from '../lib/api'
import { identityColor } from '../lib/identity'
import { timeAgo, useNow } from '../lib/time'
import { wsClient } from '../lib/ws'
import { useAuth } from '../state/auth'
import { displayPath, useTestPresence, type Tester } from '../state/useTestPresence'
import { usePreviewUrl } from '../state/usePreviewUrl'
import { useProject } from './ProjectShell'

/** the size every thumbnail renders the product at, before scaling to the tile */
const STAGE_W = 1280
const STAGE_H = 800

/**
 * The Room — every live session's product on one wall, rebuilt on each commit,
 * with the teammates testing each one drawn on top. Glanceable awareness of
 * "who is where, doing what" is what lets a group coordinate without asking.
 */
export function RoomView() {
  const { projectId, detailQuery, feed } = useProject()
  const detail = detailQuery.data
  const sessions = detail?.activeSessions ?? []
  const moduleName = useMemo(() => new Map((detail?.modules ?? []).map((m) => [m.id, m.name])), [detail?.modules])
  const watching = feed.presence.filter((p) => p.viewing).length

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-8">
        <PageHeader
          title="Room"
          meta={`${sessions.length} live session${sessions.length === 1 ? '' : 's'} · ${feed.presence.length} online · ${watching} in a session`}
          actions={
            <Link to={`/p/${projectId}`} className={buttonVariants({ variant: 'outline', size: 'md' })}>
              Dashboard
            </Link>
          }
        />

        <SectionLabel className="mt-8">Live now</SectionLabel>
        {sessions.length === 0 ? (
          <EmptyState
            className="mt-4 border border-hairline-strong bg-surface"
            title="Nobody is building right now."
            hint="Start a session from the dashboard — its live product shows up here for the whole team to test."
            action={
              <Link to={`/p/${projectId}`} className={buttonVariants({ variant: 'primary' })}>
                Go to the dashboard
              </Link>
            }
          />
        ) : (
          <ul className="mt-4 grid grid-cols-1 pl-px pt-px md:grid-cols-2 2xl:grid-cols-3">
            {sessions.map((s, i) => (
              <li key={s.id} className="-ml-px -mt-px border border-hairline-strong bg-surface">
                <RoomTile index={i} session={s} projectId={projectId} moduleName={moduleName.get(s.moduleId) ?? 'Module'} ticker={feed.tickerBySession.get(s.id)?.[0]?.gist} />
              </li>
            ))}
          </ul>
        )}

        <SectionLabel className="mt-10">Main — merged</SectionLabel>
        <div className="mt-4 max-w-[720px] border border-hairline-strong bg-surface">
          <Stage target={{ main: projectId }} reloadKey={feed.lastMerge?.branchName ?? 0} title="Merged main branch preview" testers={[]} />
          <div className="flex items-center gap-2 border-t border-hairline-strong px-3 py-2">
            <span className="telemetry text-primary">main</span>
            <span className="text-small text-secondary">What everyone has merged so far.</span>
            <a href={`/preview/main/${projectId}/`} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'ml-auto')}>
              Open main preview <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

function RoomTile({ index, session, projectId, moduleName, ticker }: { index: number; session: SessionSummary; projectId: string; moduleName: string; ticker?: string }) {
  const { user } = useAuth()
  const { testers, actions } = useTestPresence(session.id, user?.id)
  const signals = useSessionSignals(session.id, session.driverName)
  const lastAction = actions[0]
  useNow(10_000)
  const check = signals.checks?.payload
  const step = signals.plan?.payload.steps.find((s) => s.status === 'doing') ?? signals.plan?.payload.steps.find((s) => s.status === 'todo')

  return (
    <article className="flex h-full flex-col" aria-label={`${session.title}, driven by ${session.driverName}`}>
      <div className="flex items-center gap-2 border-b border-hairline-strong px-3 py-2">
        <span className="tnum telemetry bg-primary px-1.5 text-canvas">S-{String(index + 1).padStart(2, '0')}</span>
        <span className="telemetry min-w-0 truncate text-tertiary">{moduleName}</span>
        <StateChip compact state={signals.state.state} detail={signals.state.detail} className="ml-auto" />
        {signals.checking ? null : check ? (
          <span
            className={cn(
              'telemetry px-1.5 font-bold text-on-accent',
              check.status === 'passed' ? 'bg-ok' : check.status === 'warned' ? 'bg-warn' : 'bg-signal-500',
            )}
            title={`Checks ${check.status}`}
          >
            {check.status === 'passed' ? 'Pass' : check.status === 'warned' ? 'Warn' : 'Fail'}
          </span>
        ) : (
          <span className="telemetry text-tertiary">No checks</span>
        )}
      </div>

      {/* the frame is not interactive content inside a link: the link overlays it as a sibling */}
      <div className="group relative">
        <Stage target={{ session: session.id }} reloadKey={signals.commitSeq} title={`Live preview of ${session.title}`} testers={testers} />
        <Link to={`/p/${projectId}/s/${session.id}`} className="absolute inset-0 focus-visible:outline-offset-[-2px]" aria-label={`Open ${session.title}`} />
        <span aria-hidden className="telemetry pointer-events-none absolute bottom-2 right-2 bg-primary px-1.5 py-0.5 text-canvas opacity-0 transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
          Open session →
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 border-t border-hairline-strong px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Avatar name={session.driverName} color={session.driverAvatarColor} size="sm" />
          <h3 className="min-w-0 truncate text-ui font-semibold text-primary">{session.title}</h3>
          <span className="ml-auto max-w-[40%] shrink-0 truncate text-small text-tertiary">{session.driverName} driving</span>
        </div>
        <div className="flex items-baseline gap-2 text-small">
          <span className="telemetry shrink-0 text-tertiary">Now</span>
          <span className="min-w-0 truncate text-primary" title={step?.text ?? signals.state.detail}>
            {signals.state.state === 'working' ? signals.state.detail : (step?.text ?? signals.state.detail)}
          </span>
        </div>
        {ticker && <div className="truncate text-small text-secondary">{ticker}</div>}
        <div className="mt-auto flex items-center gap-2 pt-1">
          {testers.length === 0 ? (
            <span className="telemetry text-tertiary">Nobody testing</span>
          ) : (
            <>
              <span className="sr-only">Testing: {testers.map((t) => `${t.name} on ${displayPath(t.path)}`).join(', ')}</span>
              <span className="flex" aria-hidden>
                {testers.slice(0, 4).map((t) => (
                  <span key={t.userId} title={`${t.name} on ${displayPath(t.path)}`} className="telemetry -ml-px flex h-5 min-w-5 items-center justify-center border border-hairline-strong px-0.5 text-primary" style={{ background: identityColor(t.color) }}>
                    {t.name.slice(0, 2)}
                  </span>
                ))}
              </span>
              <span className="telemetry text-secondary">{testers.length} testing</span>
            </>
          )}
          {lastAction && (
            <span
              className={cn('ml-auto min-w-0 truncate text-small', lastAction.kind === 'error' ? 'text-danger' : 'text-tertiary')}
              title={lastAction.kind === 'error' ? lastAction.message : lastAction.label}
            >
              {lastAction.name} {lastAction.kind === 'click' ? `clicked ${lastAction.label || 'the page'}` : lastAction.kind === 'nav' ? `opened ${displayPath(lastAction.path)}` : 'hit an error'} · {timeAgo(new Date(lastAction.at).toISOString())}
            </span>
          )}
        </div>
      </div>
    </article>
  )
}

/** A product preview rendered at desktop size and scaled to fit, with testers' pointers on top. */
export function Stage({ target, reloadKey, title, testers }: { target: { session: string } | { main: string } | { live: string }; reloadKey: number | string; title: string; testers: Tester[] }) {
  const src = usePreviewUrl(target)
  const boxRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / STAGE_W)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={boxRef} className="relative w-full overflow-hidden bg-white" style={{ aspectRatio: `${STAGE_W} / ${STAGE_H}` }}>
      {!src && <div role="status" className="telemetry absolute inset-0 flex items-center justify-center text-tertiary">Loading preview…</div>}
      {src && <iframe
        key={`${src}-${reloadKey}`}
        src={`${src}?_v=${reloadKey}`}
        title={title}
        sandbox="allow-scripts"
        tabIndex={-1}
        loading="lazy"
        className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
        style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
      />}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {testers.map((t) =>
          t.x === null || t.y === null ? null : (
            <span
              key={t.userId}
              className="absolute left-0 top-0 transition-transform duration-fast motion-reduce:transition-none"
              style={{ transform: `translate(${(t.x - t.scrollX) * scale * (STAGE_W / Math.max(t.vw || STAGE_W, 1))}px, ${(t.y - t.scrollY) * scale * (STAGE_W / Math.max(t.vw || STAGE_W, 1))}px)` }}
            >
              <span className="block h-2.5 w-2.5 border-2 border-[#111]" style={{ background: identityColor(t.color) }} />
              <span className="telemetry ml-2 border border-[#111] px-0.5 text-[10px] text-[#111]" style={{ background: identityColor(t.color) }}>
                {t.name}
              </span>
            </span>
          ),
        )}
      </div>
    </div>
  )
}

/** The bits of a session the Room needs: latest commit (reload), checks, plan, derived state — kept live. */
function useSessionSignals(sessionId: string, driverName: string) {
  const detailQuery = useQuery({
    queryKey: ['room-session', sessionId],
    queryFn: () => api.get<SessionDetail>(`/api/sessions/${sessionId}`),
    staleTime: 30_000,
  })
  const [live, setLive] = useState<SessionEvent[]>([])
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    setLive([])
    return wsClient.onMessage((msg) => {
      if (msg.t !== 'event' || msg.sessionId !== sessionId) return
      const e = msg.event
      if (e.type === 'check_started') setChecking(true)
      if (e.type === 'check_run') setChecking(false)
      if (e.seq !== null) setLive((p) => [...p, e].slice(-400))
    })
  }, [sessionId])
  const now = useNow(30_000)
  return useMemo(() => {
    const base = detailQuery.data?.events ?? []
    const seen = new Set(base.map((e) => e.id))
    const events = [...base, ...live.filter((e) => !seen.has(e.id))].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    let commitSeq = 0
    for (const e of events) if (e.type === 'commit' && (e.seq ?? 0) > commitSeq) commitSeq = e.seq ?? 0
    return { commitSeq, ...latestOf(events), checking, state: deriveSessionState({ events, driverName, checking, now }) }
  }, [detailQuery.data, live, checking, driverName, now])
}
