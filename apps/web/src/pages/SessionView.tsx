import NumberFlow from '@number-flow/react'
import { Check, Copy, Download, Eye, GitFork, Lightbulb, Link2, MonitorPlay, PanelRightClose, PanelRightOpen, Play, Repeat2 } from 'lucide-react'
import { toast } from 'sonner'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels'
import { Drawer } from 'vaul'
import { formatCost, formatTokens, sumUsage } from '@loom/shared'
import { AgentModeChip } from '../components/AiSettingsDialog'
import { ChatLog } from '../components/ChatLog'
import { Composer } from '../components/Composer'
import { PaneBoundary } from '../components/PaneBoundary'
import { PreviewPane } from '../components/PreviewPane'
import { SpectatorSidebar } from '../components/SpectatorSidebar'
import { Modal, Popover, PopoverContent, PopoverTrigger, Tooltip } from '../components/overlay'
import { Avatar, Button, LivePill, MonoChip, Pill, Spinner, StatusDot, cn } from '../components/primitives'
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
    if (!confirm('End this session? The branch and full transcript stay available.')) return
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
        <Link to={`/p/${projectId}`}>
          <Button>Back to dashboard</Button>
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
      {/* session header */}
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-hairline px-4">
        <Link
          to={`/p/${projectId}/m/${session.moduleId}`}
          className="flex min-w-0 items-center gap-1.5 text-ui text-secondary transition-colors duration-micro hover:text-primary"
          title="Back to module"
        >
          <span className="text-ui">{meta.moduleEmoji}</span>
          <span className="hidden truncate sm:inline">{meta.moduleName}</span>
        </Link>
        <span className="text-tertiary">/</span>
        <span className="min-w-0 truncate text-ui font-medium text-primary">{session.title}</span>
        {session.parentSessionId && (
          <Link to={`/p/${projectId}/s/${session.parentSessionId}`} title="Open the session this was forked from">
            <Pill tone="accent">
              <GitFork size={10} strokeWidth={1.5} /> forked
            </Pill>
          </Link>
        )}
        {isEnded ? <Pill>ended</Pill> : streamingNow ? <LivePill /> : null}

        <div className="ml-auto flex items-center gap-2.5">
          {usage.inputTokens + usage.outputTokens > 0 && (
            <Tooltip
              content={`${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out · ${usage.turns} turn${usage.turns === 1 ? '' : 's'}`}
            >
              <span className="tnum hidden font-mono text-small text-tertiary lg:inline-flex lg:items-center lg:gap-1">
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
          <span className="hidden xl:inline-flex">
            <AgentModeChip />
          </span>
          {!isEnded && (
            <span className="hidden items-center gap-1.5 text-small text-secondary md:inline-flex">
              <StatusDot tone={stream.agentStatus === 'error' ? 'danger' : streamingNow ? 'accent' : 'idle'} />
              {stream.agentStatus === 'thinking' ? 'thinking' : stream.agentStatus === 'running_tools' ? 'working' : stream.agentStatus}
            </span>
          )}
          {watchers.length > 0 && (
            <Tooltip content={watchers.map((w) => w.name).join(', ')}>
              <span className="tnum inline-flex items-center gap-1 text-small text-secondary">
                <Eye size={13} strokeWidth={1.5} />
                <NumberFlow value={watchers.length} transformTiming={NUMBER_TIMING} spinTiming={NUMBER_TIMING} />
              </span>
            </Tooltip>
          )}
          <Tooltip content={`${session.driverName} is driving`}>
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={session.driverName} color={session.driverAvatarColor} size="sm" />
              <span className="hidden text-small text-secondary md:inline">{session.driverName}</span>
            </span>
          </Tooltip>
          <MonoChip className="hidden lg:inline-flex" title="This session's git branch">
            {session.branchName}
          </MonoChip>
          {isDriver && !isEnded && (
            <Button variant="ghost" size="sm" onClick={() => void endSession()} disabled={ending}>
              End
            </Button>
          )}
          <Tooltip content="Export the session as Markdown">
            <span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  downloadMarkdown(`${session.title.replace(/[^\w.-]+/g, '-')}.md`, sessionToMarkdown(meta, stream.events))
                  toast('Exported session.md')
                }}
              >
                <Download size={14} strokeWidth={1.5} />
              </Button>
            </span>
          </Tooltip>
          {isDriver && !isEnded && (
            <Popover open={shareOpen} onOpenChange={(v) => { setShareOpen(v); if (v) void openShare() }}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Link2 size={14} strokeWidth={1.5} />
                  Share
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80">
                <div className="text-ui text-primary">Read-only share link</div>
                <div className="mt-2 flex gap-1.5">
                  <input readOnly value={shareUrl ?? 'Creating link…'} className="loom-input py-1.5 font-mono text-code-sm" />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!shareUrl}
                    onClick={async () => {
                      if (!shareUrl) return
                      await navigator.clipboard.writeText(shareUrl)
                      setShareCopied(true)
                      setTimeout(() => setShareCopied(false), 1200)
                    }}
                  >
                    {shareCopied ? <Check size={13} strokeWidth={2} className="text-ok" /> : <Copy size={13} strokeWidth={1.5} />}
                  </Button>
                </div>
                <p className="mt-2 text-small leading-relaxed text-tertiary">Anyone with the link can view this session.</p>
                <Button
                  variant="danger"
                  size="sm"
                  className="mt-2"
                  onClick={async () => {
                    await api.del(`/api/sessions/${session.id}/share`)
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
                <Button variant="ghost" size="sm" title="Pass the wheel to a watcher">
                  <Repeat2 size={14} strokeWidth={1.5} />
                  Pass the wheel
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-1.5">
                <div className="px-2 pb-1.5 pt-1 text-micro uppercase tracking-[0.08em] text-tertiary">Offer the wheel to</div>
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
            <Link to={`/replay/${session.id}`}>
              <Button variant="ghost" size="sm">
                <Play size={14} strokeWidth={1.5} />
                Replay
              </Button>
            </Link>
          </Tooltip>
          <Button variant={previewOpen ? 'outline' : 'ghost'} size="sm" onClick={() => setPreviewOpen((v) => !v)} className="hidden lg:inline-flex">
            <MonitorPlay size={14} strokeWidth={1.5} />
            Preview
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (isDesktop ? setSidebarOpen((v) => !v) : setDrawerOpen(true))}
            title="Spectate other live sessions"
          >
            {sidebarOpen && isDesktop ? <PanelRightClose size={14} strokeWidth={1.5} /> : <PanelRightOpen size={14} strokeWidth={1.5} />}
            Spectate
          </Button>
        </div>
      </header>

      {serverError && (
        <div className="border-b border-hairline bg-danger-fill px-5 py-1.5 text-center text-small text-danger">{serverError}</div>
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
            agentStatus={isEnded ? 'idle' : stream.agentStatus}
            driverName={session.driverName}
            driverColor={session.driverAvatarColor}
            ended={isEnded}
            freshSession={freshSession && isDriver && !isEnded}
            onFork={(eventId, anchorEl) => void fork(eventId, anchorEl)}
            reportReadingFor={!isDriver && !isEnded ? session.id : null}
            readers={readers}
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
                  <Link to={`/replay/${session.id}`}>
                    <Button variant="ghost" size="sm">
                      <Play size={14} strokeWidth={1.5} />
                      Replay
                    </Button>
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
                        : `You're spectating — ${session.driverName} is driving.`}{' '}
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
              <div className="relative flex min-w-0 flex-1 flex-col border-l border-hairline bg-surface">
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
