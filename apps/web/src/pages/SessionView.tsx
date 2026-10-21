import NumberFlow from '@number-flow/react'
import {
  Check,
  Copy,
  Download,
  Eye,
  GitBranch,
  GitFork,
  Lightbulb,
  Link2,
  MonitorPlay,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Repeat2,
  Settings2,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels'
import { Drawer } from 'vaul'
import { cacheHitRate, formatCost, formatTokens, sumUsage } from '@loom/shared'
import { openSettings } from '../components/CommandPalette'
import { ChatLog } from '../components/ChatLog'
import { Composer } from '../components/Composer'
import { PaneBoundary } from '../components/PaneBoundary'
import { PreviewPane } from '../components/PreviewPane'
import { SessionScrubber } from '../components/SessionScrubber'
import { SpectatorSidebar } from '../components/SpectatorSidebar'
import { Modal, Popover, PopoverContent, PopoverTrigger, Tooltip } from '../components/overlay'
import { Avatar, Button, LivePill, MonoChip, Pill, Spinner, StatusDot, buttonVariants, cn } from '../components/primitives'
import { api } from '../lib/api'
import { momentFork } from '../lib/choreography'
import { setBrowserStreamingIndicator } from '../lib/brand'
import { downloadMarkdown, sessionToMarkdown } from '../lib/exportMarkdown'
import { useMediaQuery } from '../lib/useMediaQuery'
import { wsClient } from '../lib/ws'
import { useAuth } from '../state/auth'
import { useSessionStream } from '../state/useSessionStream'
import { useProject } from './ProjectShell'

const NUMBER_TIMING: EffectTiming = { duration: 180, easing: 'cubic-bezier(0.2,0,0,1)' }

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m`
}

export function SessionView() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { projectId, feed } = useProject()
  const { user } = useAuth()
  const navigate = useNavigate()
  const stream = useSessionStream(sessionId ?? null)
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('loom.sidebar.open') !== '0')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [forking, setForking] = useState(false)
  const [ending, setEnding] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [suggestText, setSuggestText] = useState('')
  const [suggestSent, setSuggestSent] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [shareCopied, setShareCopied] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // ending is destructive for every watcher — it takes a second, explicit step
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [jumpSeq, setJumpSeq] = useState<number | null>(null)

  useEffect(() => {
    localStorage.setItem('loom.sidebar.open', sidebarOpen ? '1' : '0')
  }, [sidebarOpen])

  // F6: [ and ] toggle the spectate panel
  useEffect(() => {
    const onSidebar = (e: Event) => {
      const show = Boolean((e as CustomEvent).detail)
      if (isDesktop) setSidebarOpen(show)
      else setDrawerOpen(show)
    }
    window.addEventListener('loom:sidebar', onSidebar)
    return () => window.removeEventListener('loom:sidebar', onSidebar)
  }, [isDesktop])

  // presence: tell the hub which session we're looking at
  useEffect(() => {
    if (!sessionId) return
    wsClient.setViewing(sessionId)
    return () => wsClient.setViewing(null)
  }, [sessionId])

  // browser chrome reflects streaming (favicon + title)
  const streamingNow = stream.streamingText.length > 0 || stream.agentStatus === 'thinking' || stream.agentStatus === 'running_tools'
  useEffect(() => {
    setBrowserStreamingIndicator(streamingNow)
    return () => setBrowserStreamingIndicator(false)
  }, [streamingNow])

  // 8.2 — #seq-N deep links: land scrolled to the exact event, flashed
  const hashHandled = useRef(false)
  useEffect(() => {
    if (stream.loading || hashHandled.current) return
    const m = /^#seq-(\d+)$/.exec(location.hash)
    if (m) {
      hashHandled.current = true
      setJumpSeq(Number(m[1]))
    }
  }, [stream.loading])

  // F12 — the palette can trigger the export from anywhere in the session
  useEffect(() => {
    const onExport = () => {
      if (!stream.detail) return
      const title = stream.detail.session.title.replace(/[^\w.-]+/g, '-')
      downloadMarkdown(`${title}.md`, sessionToMarkdown(stream.detail, stream.events))
      toast('Exported session.md')
    }
    window.addEventListener('loom:export', onExport)
    return () => window.removeEventListener('loom:export', onExport)
  }, [stream.detail, stream.events])

  // F8 — the driver hears about reactions/comments as they land
  useEffect(() => {
    if (!sessionId) return
    return wsClient.onMessage((msg) => {
      if (msg.t !== 'event' || msg.sessionId !== sessionId) return
      if (msg.event.type !== 'annotation') return
      if (!user || msg.event.payload.authorUserId === user.id) return
      const p = msg.event.payload
      toast(p.kind === 'comment' ? `${p.authorName} commented: ${p.body.slice(0, 60)}` : `${p.authorName} reacted to your work`)
    })
  }, [sessionId, user])

  // surface rejected messages instead of eating them
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
  const watchers = useMemo(() => feed.presence.filter((p) => p.viewing === sessionId), [feed.presence, sessionId])
  // F5: other viewers' read positions (never your own avatar)
  const readers = useMemo(() => watchers.filter((p) => p.userId !== user?.id), [watchers, user?.id])

  // 1.1 — the driver feels the audience: toast when a watcher joins
  const prevWatcherIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    const ids = new Set(watchers.map((w) => w.userId))
    if (isDriver) {
      for (const w of watchers) {
        if (w.userId !== user?.id && !prevWatcherIds.current.has(w.userId) && prevWatcherIds.current.size > 0) {
          toast(`${w.name} is watching`)
        }
      }
    }
    prevWatcherIds.current = ids
  }, [watchers, isDriver, user?.id])

  const previewReloadKey = useMemo(() => {
    let last = 0
    for (const e of stream.events) {
      if (e.type === 'commit' && (e.seq ?? 0) > last) last = e.seq ?? 0
    }
    return last
  }, [stream.events])
  const usage = useMemo(() => sumUsage(stream.events), [stream.events])
  const freshSession = !stream.loading && stream.events.length === 0

  const fork = async (atEventId?: string, anchorEl?: HTMLElement | null) => {
    if (!sessionId || forking) return
    setForking(true)
    try {
      // M3 — the hero moment plays while the fork request runs
      const forkerColor = user?.avatarColor ?? 'var(--lav-500)'
      const [res] = await Promise.all([
        api.post<{ session: { id: string } }>(`/api/sessions/${sessionId}/fork`, { atEventId }),
        anchorEl ? momentFork(anchorEl, forkerColor) : Promise.resolve(),
      ])
      navigate(`/p/${projectId}/s/${res.session.id}`)
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Fork failed')
    } finally {
      setForking(false)
    }
  }

  const openShare = async () => {
    try {
      const res = await api.post<{ url: string }>(`/api/sessions/${sessionId}/share`)
      setShareUrl(`${location.origin}${res.url}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the link')
      setShareOpen(false)
    }
  }

  const endSession = async () => {
    if (!sessionId || ending) return
    setEnding(true)
    try {
      await api.post(`/api/sessions/${sessionId}/end`)
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not end the session')
    } finally {
      setEnding(false)
    }
  }

  if (stream.loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (stream.error || !meta || !session) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ui text-secondary">
        <div>{stream.error ?? 'Session not found.'}</div>
        <Link to={`/p/${projectId}`} className={buttonVariants()}>
          Back to dashboard
        </Link>
      </div>
    )
  }

  const spectatorPane = sessionId ? (
    <PaneBoundary label="spectate panel">
      <SpectatorSidebar projectId={projectId} currentSessionId={sessionId} onClose={() => (isDesktop ? setSidebarOpen(false) : setDrawerOpen(false))} />
    </PaneBoundary>
  ) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* session header: identity + state on the left, the few actions people use most on the right, the rest under ⋯ */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-3 sm:gap-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            to={`/p/${projectId}/m/${session.moduleId}`}
            className="flex shrink-0 items-center gap-1.5 rounded px-1 py-0.5 text-ui text-secondary transition-colors duration-micro hover:text-primary"
            aria-label={`Back to ${meta.moduleName}`}
          >
            <span aria-hidden>{meta.moduleEmoji}</span>
            <span className="hidden max-w-[10rem] truncate md:inline">{meta.moduleName}</span>
          </Link>
          <span className="hidden text-tertiary md:inline" aria-hidden>
            /
          </span>
          <h1 className="min-w-0 truncate text-ui font-medium text-primary" title={`${session.title} — branch ${session.branchName}`}>
            {session.title}
          </h1>
          {session.parentSessionId && (
            <Link to={`/p/${projectId}/s/${session.parentSessionId}`} title="Open the session this was forked from" className="hidden shrink-0 sm:inline-flex">
              <Pill tone="accent">
                <GitFork size={10} strokeWidth={1.5} aria-hidden /> forked
              </Pill>
            </Link>
          )}
          {isEnded ? (
            <Pill className="shrink-0">ended</Pill>
          ) : streamingNow ? (
            <LivePill className="shrink-0" label={stream.agentStatus === 'running_tools' ? 'Working' : 'Live'} />
          ) : (
            <span className="hidden shrink-0 items-center gap-1.5 text-small text-tertiary sm:inline-flex" role="status">
              <StatusDot tone={stream.agentStatus === 'error' ? 'danger' : 'idle'} />
              {stream.agentStatus === 'error' ? 'needs attention' : 'idle'}
            </span>
          )}
        </div>

        {/* meta: who, how many, how much */}
        <div className="hidden shrink-0 items-center gap-3 border-r border-hairline pr-3 lg:flex">
          {usage.inputTokens + usage.outputTokens > 0 && (
            <Tooltip
              content={`${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out${
                usage.cacheReadTokens > 0
                  ? ` · ${usage.cacheReadTokens.toLocaleString()} from cache (${Math.round(cacheHitRate(usage) * 100)}% of input)`
                  : ''
              } · ${usage.turns} turn${usage.turns === 1 ? '' : 's'}`}
            >
              <span className="tnum inline-flex items-center gap-1 font-mono text-small text-tertiary">
                <NumberFlow
                  value={usage.inputTokens + usage.outputTokens}
                  format={{ notation: 'compact' }}
                  transformTiming={NUMBER_TIMING}
                  spinTiming={NUMBER_TIMING}
                />
                <span>tok</span>
                {usage.costUsd > 0 && <span>· {formatCost(usage.costUsd)}</span>}
              </span>
            </Tooltip>
          )}
          {watchers.length > 0 && (
            <Tooltip content={`Watching: ${watchers.map((w) => w.name).join(', ')}`}>
              <span className="tnum inline-flex items-center gap-1 text-small text-secondary">
                <Eye size={13} strokeWidth={1.5} aria-hidden />
                <NumberFlow value={watchers.length} transformTiming={NUMBER_TIMING} spinTiming={NUMBER_TIMING} />
                <span className="sr-only">watching</span>
              </span>
            </Tooltip>
          )}
          <Tooltip content={`${session.driverName} is driving`}>
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={session.driverName} color={session.driverAvatarColor} size="sm" />
              <span className="text-small text-secondary">{session.driverName}</span>
            </span>
          </Tooltip>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isDriver && !isEnded && (
            <Popover open={shareOpen} onOpenChange={(v) => { setShareOpen(v); if (v) void openShare() }}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Share a read-only link">
                  <Link2 size={14} strokeWidth={1.5} aria-hidden />
                  <span className="hidden xl:inline">Share</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80">
                <div className="text-ui text-primary">Read-only share link</div>
                <div className="mt-2 flex gap-1.5">
                  <input
                    readOnly
                    aria-label="Share link"
                    value={shareUrl ?? 'Creating link…'}
                    className="loom-input py-1.5 font-mono text-code-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={shareCopied ? 'Copied' : 'Copy link'}
                    disabled={!shareUrl}
                    onClick={async () => {
                      if (!shareUrl) return
                      try {
                        await navigator.clipboard.writeText(shareUrl)
                      } catch {
                        toast('Could not copy — select the link and copy it instead')
                        return
                      }
                      setShareCopied(true)
                      setTimeout(() => setShareCopied(false), 1200)
                    }}
                  >
                    {shareCopied ? <Check size={13} strokeWidth={2} className="text-ok" aria-hidden /> : <Copy size={13} strokeWidth={1.5} aria-hidden />}
                  </Button>
                </div>
                <p className="mt-2 text-small leading-relaxed text-tertiary">Anyone with the link can view this session.</p>
                <Button
                  variant="danger"
                  size="sm"
                  className="mt-2"
                  onClick={async () => {
                    try {
                      await api.del(`/api/sessions/${session.id}/share`)
                    } catch {
                      toast('Could not revoke — the link still works. Try again.')
                      return
                    }
                    setShareUrl(null)
                    setShareOpen(false)
                    toast('Share link revoked')
                  }}
                >
                  Revoke link
                </Button>
              </PopoverContent>
            </Popover>
          )}
          {isDriver && !isEnded && watchers.some((w) => w.userId !== user?.id) && (
            <Popover open={handoffOpen} onOpenChange={setHandoffOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Pass the wheel to a watcher">
                  <Repeat2 size={14} strokeWidth={1.5} aria-hidden />
                  <span className="hidden xl:inline">Pass the wheel</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-1.5">
                <div className="px-2 pb-1.5 pt-1 text-small font-medium text-tertiary">Offer the wheel to</div>
                {watchers
                  .filter((w) => w.userId !== user?.id)
                  .map((w) => (
                    <button
                      key={w.userId}
                      onClick={() => {
                        wsClient.handoffOffer(session.id, w.userId)
                        setHandoffOpen(false)
                        toast(`Offered the wheel to ${w.name}`)
                      }}
                      className="flex h-9 w-full items-center gap-2.5 rounded px-2 text-left text-ui text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary"
                    >
                      <Avatar name={w.name} color={w.avatarColor} size="sm" />
                      {w.name}
                    </button>
                  ))}
              </PopoverContent>
            </Popover>
          )}
          <Tooltip content="Replay — scrub, play back, fork from any point">
            <Link to={`/replay/${session.id}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })} aria-label="Replay">
              <Play size={14} strokeWidth={1.5} aria-hidden />
              <span className="hidden xl:inline">Replay</span>
            </Link>
          </Tooltip>
          <Button
            variant={previewOpen ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setPreviewOpen((v) => !v)}
            className="hidden lg:inline-flex"
            aria-pressed={previewOpen}
            aria-label="Live preview"
          >
            <MonitorPlay size={14} strokeWidth={1.5} aria-hidden />
            <span className="hidden xl:inline">Preview</span>
          </Button>
          <Button
            variant={sidebarOpen && isDesktop ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => (isDesktop ? setSidebarOpen((v) => !v) : setDrawerOpen(true))}
            aria-label="Spectate other live sessions"
            aria-pressed={isDesktop ? sidebarOpen : undefined}
          >
            {sidebarOpen && isDesktop ? <PanelRightClose size={14} strokeWidth={1.5} aria-hidden /> : <PanelRightOpen size={14} strokeWidth={1.5} aria-hidden />}
            <span className="hidden xl:inline">Spectate</span>
          </Button>

          <Popover open={moreOpen} onOpenChange={(v) => { setMoreOpen(v); if (!v) setConfirmEnd(false) }}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="More session actions">
                <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-1.5">
              {confirmEnd ? (
                <div className="p-2">
                  <div className="text-ui font-medium text-primary">End this session for everyone?</div>
                  <p className="mt-1 text-small text-tertiary">
                    The transcript, commits and branch stay. Anyone can still replay it or fork it to keep going.
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setConfirmEnd(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={ending}
                      onClick={() => {
                        setMoreOpen(false)
                        setConfirmEnd(false)
                        void endSession()
                      }}
                    >
                      {ending ? 'Ending…' : 'End session'}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="px-2 pb-1.5 pt-1">
                    <div className="text-small text-tertiary">Branch</div>
                    <div className="mt-0.5 truncate font-mono text-code-sm text-secondary" translate="no">
                      {session.branchName}
                    </div>
                  </div>
                  <div className="my-1 border-t border-hairline" />
                  <MenuItem
                    icon={<GitBranch size={14} strokeWidth={1.5} aria-hidden />}
                    onClick={async () => {
                      setMoreOpen(false)
                      await navigator.clipboard.writeText(session.branchName).then(
                        () => toast('Branch name copied'),
                        () => toast(`Could not copy — the branch is ${session.branchName}`),
                      )
                    }}
                  >
                    Copy branch name
                  </MenuItem>
                  <MenuItem
                    icon={<Download size={14} strokeWidth={1.5} aria-hidden />}
                    onClick={() => {
                      downloadMarkdown(`${session.title.replace(/[^\w.-]+/g, '-')}.md`, sessionToMarkdown(meta, stream.events))
                      setMoreOpen(false)
                      toast('Exported session.md')
                    }}
                  >
                    Export as Markdown
                  </MenuItem>
                  <MenuItem
                    icon={<Settings2 size={14} strokeWidth={1.5} aria-hidden />}
                    onClick={() => {
                      setMoreOpen(false)
                      openSettings()
                    }}
                  >
                    AI provider &amp; effort…
                  </MenuItem>
                  {isDriver && !isEnded && (
                    <>
                      <div className="my-1 border-t border-hairline" />
                      <MenuItem tone="danger" icon={<Square size={14} strokeWidth={1.5} aria-hidden />} onClick={() => setConfirmEnd(true)}>
                        End session…
                      </MenuItem>
                    </>
                  )}
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {serverError && (
        <div role="alert" className="border-b border-hairline bg-danger-fill px-5 py-1.5 text-center text-small text-danger">
          {serverError}
        </div>
      )}

      <Group
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={loadLayout()}
        onLayoutChanged={(layout) => saveLayout(layout)}
      >
        <Panel id="log" minSize={480} className="flex h-full min-w-0 flex-col">
          {isEnded && (
            <div className="flex items-center justify-center gap-2 border-b border-hairline px-5 py-2 text-small text-secondary">
              <span className="font-mono text-code-sm text-tertiary">session ended</span>
              <span aria-hidden>·</span>
              <button onClick={(e) => void fork(undefined, e.currentTarget)} className="text-lav-300 transition-colors duration-micro hover:text-lav-400">
                Fork to continue
              </button>
            </div>
          )}
          <PaneBoundary label="event log">
          <ChatLog
            testId="main-log"
            events={stream.events}
            streamingText={stream.streamingText}
            thinkingText={stream.thinkingText}
            agentStatus={isEnded ? 'idle' : stream.agentStatus}
            driverName={session.driverName}
            driverColor={session.driverAvatarColor}
            ended={isEnded}
            freshSession={freshSession && isDriver && !isEnded}
            onFork={(eventId, anchorEl) => void fork(eventId, anchorEl)}
            reportReadingFor={!isDriver && !isEnded ? session.id : null}
            readers={readers}
            onReact={!isDriver && !isEnded ? (emoji, atSeq) => wsClient.react(session.id, emoji, atSeq) : undefined}
            jumpToSeq={jumpSeq}
            onJumped={() => setJumpSeq(null)}
            pending={isDriver ? stream.pending : undefined}
            onRetryPending={stream.retryPending}
            onDiscardPending={stream.discardPending}
            actions={{
              isDriver,
              projectId,
              onResolveSuggestion: (suggestionId, decision) => wsClient.resolveSuggestion(session.id, suggestionId, decision),
              onAnnotate: (targetEventId, kind, body) => {
                if (!wsClient.annotate(session.id, targetEventId, kind, body)) {
                  toast('Connection lost — try again in a second.')
                }
              },
            }}
            emptyHint={
              isDriver
                ? 'Tell the agent what to build — it reads and writes this project’s real code.'
                : 'Nothing here yet.'
            }
          />
          </PaneBoundary>

          <SessionScrubber events={stream.events} driverColor={session.driverAvatarColor} onPeek={(seq) => setJumpSeq(seq)} />

          {isEnded && meta.digest ? (
            <div className="border-t border-hairline px-6 py-4">
              <div className="mx-auto max-w-[760px]">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="text-h4 text-primary">{meta.digest.title}</h3>
                    <ul className="mt-2 space-y-1">
                      {meta.digest.bullets.map((b, i) => (
                        <li key={i} className="flex gap-2 text-body leading-relaxed text-secondary">
                          <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-lav-500" />
                          <span className="min-w-0">{b}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="tnum shrink-0 text-right font-mono text-small text-tertiary">
                    <div>
                      <NumberFlow value={meta.digest.commitCount} transformTiming={NUMBER_TIMING} spinTiming={NUMBER_TIMING} />{' '}
                      commit{meta.digest.commitCount === 1 ? '' : 's'}
                    </div>
                    <div className="mt-0.5">{formatDuration(meta.digest.durationMs)}</div>
                  </div>
                </div>
                {meta.digest.files.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {meta.digest.files.map((f) => (
                      <MonoChip key={f}>{f}</MonoChip>
                    ))}
                  </div>
                )}
                <div className="mt-3.5 flex items-center gap-2">
                  <Button variant="primary" size="sm" disabled={forking} onClick={(e) => void fork(undefined, e.currentTarget)}>
                    <GitFork size={14} strokeWidth={1.5} />
                    {forking ? 'Forking…' : 'Fork & continue from here'}
                  </Button>
                  <Link to={`/replay/${session.id}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                    <Play size={14} strokeWidth={1.5} aria-hidden />
                    Watch the replay
                  </Link>
                </div>
              </div>
            </div>
          ) : isDriver && !isEnded ? (
            <Composer sessionId={session.id} agentStatus={stream.agentStatus} fresh={freshSession} onSend={stream.sendMessage} />
          ) : (
            <div className="border-t border-hairline px-6 py-3.5">
              <div className="mx-auto max-w-[760px]">
                {!isEnded && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      const text = suggestText.trim()
                      if (!text) return
                      if (wsClient.suggest(session.id, text)) {
                        setSuggestText('')
                        setSuggestSent(true)
                        setTimeout(() => setSuggestSent(false), 2500)
                      }
                    }}
                    className="mb-2.5 flex items-center gap-2"
                  >
                    <input
                      value={suggestText}
                      onChange={(e) => setSuggestText(e.target.value)}
                      name="suggestion"
                      autoComplete="off"
                      aria-label={`Suggest a next step to ${session.driverName}`}
                      placeholder={`Suggest a next step to ${session.driverName} — they can accept it with one click…`}
                      className="loom-input"
                      maxLength={2000}
                    />
                    <Button type="submit" variant="outline" size="md" disabled={!suggestText.trim()}>
                      <Lightbulb size={14} strokeWidth={1.5} />
                      Suggest
                    </Button>
                  </form>
                )}
                <div className="flex items-center gap-3">
                  <div className="text-small text-secondary">
                    {isEnded
                      ? 'Session ended.'
                      : suggestSent
                        ? `Sent — ${session.driverName} sees your suggestion in their chat.`
                        : `You’re spectating — ${session.driverName} is driving.`}{' '}
                    Fork to get {isEnded ? 'its' : 'their'} full conversation and code as your own session.
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    className="ml-auto shrink-0"
                    disabled={forking}
                    onClick={(e) => void fork(undefined, e.currentTarget)}
                  >
                    <GitFork size={14} strokeWidth={1.5} />
                    {forking ? 'Forking…' : 'Fork & continue from here'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Panel>

        {previewOpen && sessionId && isDesktop && (
          <>
            <ResizeHandle />
            <Panel id="preview" defaultSize="34" minSize={320} className="flex h-full min-w-0">
              <PreviewPane
                src={`/preview/session/${sessionId}/`}
                reloadKey={previewReloadKey}
                onClose={() => setPreviewOpen(false)}
                label={previewReloadKey > 0 ? session.branchName : 'nothing built yet — send a message'}
              />
            </Panel>
          </>
        )}

        {sidebarOpen && isDesktop && sessionId && (
          <>
            <ResizeHandle />
            <Panel id="spectate" defaultSize={340} minSize={260} maxSize={520} className="flex h-full min-w-0">
              {spectatorPane}
            </Panel>
          </>
        )}
      </Group>

      {/* below 1024px the sidebar is a right-anchored drawer */}
      {!isDesktop && (
        <Drawer.Root direction="right" open={drawerOpen} onOpenChange={setDrawerOpen}>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-scrim bg-scrim" />
            <Drawer.Content className="fixed bottom-0 right-0 top-0 z-modal flex w-[85vw] max-w-[380px] outline-none">
              <Drawer.Title className="sr-only">Spectate live sessions</Drawer.Title>
              <div className="relative flex min-w-0 flex-1 flex-col overscroll-contain border-l border-hairline bg-surface">
                <span aria-hidden className="absolute left-1.5 top-1/2 h-8 w-1 -translate-y-1/2 rounded-full bg-hairline-strong" />
                {spectatorPane}
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      )}
    </div>
  )
}

const LAYOUT_KEY = 'loom.session.layout'

function loadLayout(): Layout | undefined {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    return raw ? (JSON.parse(raw) as Layout) : undefined
  } catch {
    return undefined
  }
}

function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    /* storage unavailable */
  }
}

/** 4px hairline handle; lavender on hover/drag; double-click resets (built in). */
function ResizeHandle() {
  return (
    <Separator className="loom-separator group relative w-1 shrink-0">
      <span aria-hidden className="absolute inset-y-0 left-0 w-px bg-hairline transition-colors duration-micro group-hover:bg-lav-border group-data-[separator-active]:bg-lav-border" />
    </Separator>
  )
}

function MenuItem({
  icon,
  children,
  onClick,
  tone = 'default',
}: {
  icon: ReactNode
  children: ReactNode
  onClick: () => void
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded px-2 text-left text-ui transition-colors duration-micro',
        tone === 'danger' ? 'text-danger hover:bg-danger-fill' : 'text-secondary hover:bg-raised hover:text-primary',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {children}
    </button>
  )
}
