import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import type { AgentActivityStatus } from '@loom/shared'
import { ChatLog } from '../components/ChatLog'
import { Avatar, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useReplayStream } from '../state/useReplayStream'

const SPEEDS = [0.5, 1, 2, 4] as const
const BASE_STEP_MS = 750

export function ReplayView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const { detail, events, loading, error } = useReplayStream(sessionId ?? null)

  const [position, setPosition] = useState(0) // number of events revealed
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const [forking, setForking] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const total = events.length

  // once loaded, start paused at the end (the "arrived 3h late" viewer sees the
  // finished state; hit ⏮ or scrub to replay from anywhere)
  const initialized = useRef(false)
  useEffect(() => {
    if (!initialized.current && total > 0) {
      initialized.current = true
      setPosition(total)
    }
  }, [total])

  // advance while playing
  useEffect(() => {
    if (!playing) return
    if (position >= total) {
      setPlaying(false)
      return
    }
    timer.current = setTimeout(() => setPosition((p) => Math.min(p + 1, total)), BASE_STEP_MS / speed)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [playing, position, total, speed])

  const revealed = useMemo(() => events.slice(0, position), [events, position])

  const commitMarkers = useMemo(
    () =>
      events
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === 'commit')
        .map(({ e, i }) => ({ index: i + 1, label: e.type === 'commit' ? e.payload.plainExplanation : '' })),
    [events],
  )

  // derive the agent's status at the current point (for the thinking indicator)
  const agentStatus: AgentActivityStatus = useMemo(() => {
    for (let i = revealed.length - 1; i >= 0; i--) {
      const e = revealed[i]!
      if (e.type === 'status') return e.payload.status
      if (e.type === 'user_message') return 'thinking'
    }
    return 'idle'
  }, [revealed])

  const play = () => {
    if (position >= total) setPosition(0) // replay from the top
    setPlaying(true)
  }

  const fork = async (atEventId?: string) => {
    if (!sessionId || forking) return
    const eventId = atEventId ?? events[position - 1]?.id
    setForking(true)
    try {
      const res = await api.post<{ session: { id: string } }>(`/api/sessions/${sessionId}/fork`, {
        atEventId: eventId,
      })
      const pid = detail?.session.projectId
      navigate(pid ? `/p/${pid}/s/${res.session.id}` : `/`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Fork failed')
    } finally {
      setForking(false)
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/replay/${sessionId}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard blocked — no-op
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-7 w-7" />
      </div>
    )
  }
  if (error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-ink-300">
        <div>{error ?? 'Replay not found'}</div>
        <Link className="btn-secondary" to="/">
          Home
        </Link>
      </div>
    )
  }

  const s = detail.session
  const atEnd = position >= total
  const scrubEvent = position > 0 ? events[position - 1] : null

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900/60 px-5 py-3">
        <Link to="/" className="text-lg" title="Home">
          🧵
        </Link>
        <span className="text-lg">{detail.moduleEmoji}</span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{s.title}</div>
          <div className="text-[11px] text-ink-400">
            replay · {detail.moduleName} · driven by {s.driverName}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => void copyLink()} className="btn-secondary text-xs" title="Copy a link to this replay">
            {copied ? '✓ Copied' : '🔗 Copy replay link'}
          </button>
          <Link to={`/p/${s.projectId}/s/${s.id}`} className="btn-ghost text-xs">
            Open live session →
          </Link>
        </div>
      </header>

      {/* chat playback */}
      <ChatLog
        events={revealed}
        streamingText=""
        agentStatus={agentStatus}
        driverName={s.driverName}
        driverColor={s.driverAvatarColor}
        onFork={(eventId) => void fork(eventId)}
        emptyHint="Press play to replay this session from the beginning."
      />

      {/* transport */}
      <div className="border-t border-ink-700 bg-ink-900/80 px-5 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => setPosition(0)} className="btn-ghost px-2 py-1 text-sm" title="Jump to start">
            ⏮
          </button>
          <button
            onClick={() => (playing ? setPlaying(false) : play())}
            className="btn-primary px-3 py-1.5 text-sm"
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? '⏸ Pause' : atEnd ? '↺ Replay' : '▶ Play'}
          </button>
          <button onClick={() => setPosition(total)} className="btn-ghost px-2 py-1 text-sm" title="Jump to end">
            ⏭
          </button>

          {/* scrubber with commit markers */}
          <div className="relative mx-2 flex-1">
            <input
              type="range"
              min={0}
              max={total}
              value={position}
              onChange={(e) => {
                setPlaying(false)
                setPosition(Number(e.target.value))
              }}
              className="w-full accent-accent"
            />
            <div className="pointer-events-none absolute inset-x-0 top-1/2 -z-10 h-0">
              {commitMarkers.map((m, i) => (
                <span
                  key={i}
                  title={m.label}
                  className="absolute h-2 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/80"
                  style={{ left: `${total > 0 ? (m.index / total) * 100 : 0}%` }}
                />
              ))}
            </div>
          </div>

          <span className="w-14 shrink-0 text-right font-mono text-[11px] text-ink-400">
            {position}/{total}
          </span>

          {/* speed */}
          <div className="flex overflow-hidden rounded-lg border border-ink-600">
            {SPEEDS.map((sp) => (
              <button
                key={sp}
                onClick={() => setSpeed(sp)}
                className={clsx(
                  'px-2 py-1 text-[11px]',
                  speed === sp ? 'bg-accent text-ink-950' : 'bg-ink-850 text-ink-300 hover:text-ink-100',
                )}
              >
                {sp}×
              </button>
            ))}
          </div>

          <button
            onClick={() => void fork()}
            disabled={forking || position === 0}
            className="btn-secondary shrink-0 text-xs"
            title="Fork a new session from the currently-shown point"
          >
            {forking ? 'Forking…' : '⑂ Fork from here'}
          </button>
        </div>
        {scrubEvent && (
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ink-400">
            <Avatar name={s.driverName} color={s.driverAvatarColor} size="xs" />
            <span className="truncate">
              at #{position}: {describeEvent(scrubEvent)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function describeEvent(e: import('@loom/shared').SessionEvent): string {
  switch (e.type) {
    case 'user_message':
      return `${truncate(e.payload.text, 70)}`
    case 'assistant_message':
      return `agent: ${truncate(e.payload.text.replace(/\s+/g, ' '), 70)}`
    case 'tool_call':
      return `tool: ${e.payload.toolName}`
    case 'tool_result':
      return e.payload.summary
    case 'file_change':
      return `edited ${e.payload.path}`
    case 'commit':
      return `📦 ${truncate(e.payload.plainExplanation, 64)}`
    case 'status':
      return e.payload.note ?? e.payload.status
    case 'fork_marker':
      return `${e.payload.byUserName} forked here`
    default:
      return e.type
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
