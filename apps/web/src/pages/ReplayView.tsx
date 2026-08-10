import { Check, GitFork, Link2, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { AgentActivityStatus } from '@loom/shared'
import { ChatLog } from '../components/ChatLog'
import { Wordmark } from '../components/Wordmark'
import { Tooltip } from '../components/overlay'
import { Avatar, Button, IconButton, Pill, SegmentedControl, Spinner } from '../components/primitives'
import { api } from '../lib/api'
import { useReplayStream } from '../state/useReplayStream'

const SPEEDS = ['1', '2', '4'] as const
const BASE_STEP_MS = 750

export function ReplayView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const { detail, events, loading, error } = useReplayStream(sessionId ?? null)

  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>('1')
  const [forking, setForking] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const total = events.length

  // start paused at the end — the late viewer sees the finished state
  const initialized = useRef(false)
  useEffect(() => {
    if (!initialized.current && total > 0) {
      initialized.current = true
      setPosition(total)
    }
  }, [total])

  useEffect(() => {
    if (!playing) return
    if (position >= total) {
      setPlaying(false)
      return
    }
    timer.current = setTimeout(() => setPosition((p) => Math.min(p + 1, total)), BASE_STEP_MS / Number(speed))
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [playing, position, total, speed])

  // keyboard: ← → step, space toggles
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setPlaying(false)
        setPosition((p) => Math.max(0, p - 1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setPlaying(false)
        setPosition((p) => Math.min(total, p + 1))
      } else if (e.key === ' ') {
        e.preventDefault()
        setPlaying((v) => (position >= total ? v : !v))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [total, position])

  const revealed = useMemo(() => events.slice(0, position), [events, position])

  const commitMarkers = useMemo(
    () =>
      events
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === 'commit')
        .map(({ e, i }) => ({ index: i + 1, label: e.type === 'commit' ? e.payload.plainExplanation : '' })),
    [events],
  )

  const agentStatus: AgentActivityStatus = useMemo(() => {
    for (let i = revealed.length - 1; i >= 0; i--) {
      const e = revealed[i]!
      if (e.type === 'status') return e.payload.status
      if (e.type === 'user_message') return 'thinking'
    }
    return 'idle'
  }, [revealed])

  const play = () => {
    if (position >= total) setPosition(0)
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
    } catch {
      setForking(false)
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/replay/${sessionId}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked */
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }
  if (error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-ui text-secondary">
        <div>{error ?? 'Replay not found.'}</div>
        <Link to="/">
          <Button>Home</Button>
        </Link>
      </div>
    )
  }

  const s = detail.session
  const atEnd = position >= total

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-4">
        <Link to="/" className="text-primary transition-colors duration-micro hover:text-lav-300" aria-label="Home">
          <Wordmark height={16} />
        </Link>
        <Pill tone="accent">Replay</Pill>
        <div className="min-w-0">
          <div className="truncate text-ui font-medium text-primary">{s.title}</div>
          <div className="truncate text-small text-tertiary">
            {detail.moduleName} · driven by {s.driverName}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void copyLink()}>
            {copied ? <Check size={14} strokeWidth={1.5} className="text-ok" /> : <Link2 size={14} strokeWidth={1.5} />}
            {copied ? 'Copied' : 'Copy replay link'}
          </Button>
          <Link to={`/p/${s.projectId}/s/${s.id}`}>
            <Button variant="ghost" size="sm">
              Open live session →
            </Button>
          </Link>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[860px] flex-1 flex-col">
        <ChatLog
          events={revealed}
          streamingText=""
          agentStatus={agentStatus}
          driverName={s.driverName}
          driverColor={s.driverAvatarColor}
          onFork={(eventId) => void fork(eventId)}
          emptyHint="Press play to replay this session from the beginning."
        />

        {/* the transport — 48px deck above where the composer would sit */}
        <div className="shrink-0 border-t border-hairline px-4 py-2.5">
          <div className="flex h-9 items-center gap-2">
            <IconButton label="Jump to start" onClick={() => setPosition(0)}>
              <SkipBack size={15} strokeWidth={1.5} />
            </IconButton>
            <button
              onClick={() => (playing ? setPlaying(false) : play())}
              title={playing ? 'Pause (space)' : 'Play (space)'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-lav-500 text-on-accent transition-colors duration-micro hover:bg-lav-400"
            >
              {playing ? <Pause size={15} strokeWidth={2} /> : <Play size={15} strokeWidth={2} className="ml-0.5" />}
            </button>
            <IconButton label="Jump to end" onClick={() => setPosition(total)}>
              <SkipForward size={15} strokeWidth={1.5} />
            </IconButton>

            {/* scrubber: 2px track, commit notches, 12px lavender head */}
            <div className="relative mx-2 h-8 min-w-0 flex-1">
              <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-hairline-strong">
                <div
                  className="h-full rounded-full bg-lav-500"
                  style={{ width: `${total > 0 ? (position / total) * 100 : 0}%`, transition: 'width 100ms var(--ease-standard)' }}
                />
              </div>
              {commitMarkers.map((m, i) => (
                <Tooltip key={i} content={m.label}>
                  <span
                    className="absolute top-1/2 h-[8px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{
                      left: `${total > 0 ? (m.index / total) * 100 : 0}%`,
                      background: m.index <= position ? 'var(--lav-300)' : 'var(--thread-node)',
                    }}
                  />
                </Tooltip>
              ))}
              <input
                type="range"
                min={0}
                max={total}
                value={position}
                aria-label="Replay position"
                onChange={(e) => {
                  setPlaying(false)
                  setPosition(Number(e.target.value))
                }}
                className="replay-range absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent"
              />
            </div>

            <span className="tnum w-16 shrink-0 text-right font-mono text-small text-tertiary">
              {position} / {total}
            </span>

            <SegmentedControl
              size="sm"
              value={speed}
              onChange={setSpeed}
              options={SPEEDS.map((sp) => ({ value: sp, label: `${sp}×` }))}
            />

            <Button variant="outline" size="sm" onClick={() => void fork()} disabled={forking || position === 0}>
              <GitFork size={13} strokeWidth={1.5} />
              {forking ? 'Forking…' : 'Fork from here'}
            </Button>
          </div>
          {position > 0 && events[position - 1] && (
            <div className="mt-1 flex min-h-[18px] items-center gap-2 text-small text-tertiary">
              <Avatar name={s.driverName} color={s.driverAvatarColor} size="xs" />
              <span className="tnum font-mono text-small">#{position}</span>
              <span className="truncate">{describeEvent(events[position - 1]!)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function describeEvent(e: import('@loom/shared').SessionEvent): string {
  switch (e.type) {
    case 'user_message':
      return truncate(e.payload.text, 70)
    case 'assistant_message':
      return `agent: ${truncate(e.payload.text.replace(/\s+/g, ' '), 70)}`
    case 'tool_call':
      return `tool: ${e.payload.toolName}`
    case 'tool_result':
      return e.payload.summary
    case 'file_change':
      return `edited ${e.payload.path}`
    case 'commit':
      return `committed: ${truncate(e.payload.plainExplanation, 64)}`
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
