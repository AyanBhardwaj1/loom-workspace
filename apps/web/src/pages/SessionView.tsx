import NumberFlow from '@number-flow/react'
import { Eye, GitFork, Lightbulb, MonitorPlay, PanelRightClose, PanelRightOpen, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels'
import { Drawer } from 'vaul'
import { formatCost, formatTokens, sumUsage } from '@loom/shared'
import { AgentModeChip } from '../components/AiSettingsDialog'
import { ChatLog } from '../components/ChatLog'
import { Composer } from '../components/Composer'
import { PreviewPane } from '../components/PreviewPane'
import { SpectatorSidebar } from '../components/SpectatorSidebar'
import { Tooltip } from '../components/overlay'
import { Avatar, Button, LivePill, MonoChip, Pill, Spinner, StatusDot, cn } from '../components/primitives'
import { api } from '../lib/api'
import { momentFork } from '../lib/choreography'
import { setBrowserStreamingIndicator } from '../lib/brand'
import { useMediaQuery } from '../lib/useMediaQuery'
import { wsClient } from '../lib/ws'
import { useAuth } from '../state/auth'
import { useSessionStream } from '../state/useSessionStream'
import { useProject } from './ProjectShell'

const NUMBER_TIMING: EffectTiming = { duration: 180, easing: 'cubic-bezier(0.2,0,0,1)' }

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

  useEffect(() => {
    localStorage.setItem('loom.sidebar.open', sidebarOpen ? '1' : '0')
  }, [sidebarOpen])

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
    <SpectatorSidebar projectId={projectId} currentSessionId={sessionId} onClose={() => (isDesktop ? setSidebarOpen(false) : setDrawerOpen(false))} />
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
          <ChatLog
            events={stream.events}
            streamingText={stream.streamingText}
            agentStatus={isEnded ? 'idle' : stream.agentStatus}
            driverName={session.driverName}
            driverColor={session.driverAvatarColor}
            ended={isEnded}
            freshSession={freshSession && isDriver && !isEnded}
            onFork={(eventId) => {
              const row = document.activeElement?.closest?.('[data-event-row]') as HTMLElement | null
              void fork(eventId, row)
            }}
            actions={{
              isDriver,
              projectId,
              onResolveSuggestion: (suggestionId, decision) => wsClient.resolveSuggestion(session.id, suggestionId, decision),
            }}
            emptyHint={
              isDriver
                ? 'Tell the agent what to build — it reads and writes this project’s real code.'
                : 'Nothing here yet.'
            }
          />

          {isDriver && !isEnded ? (
            <Composer sessionId={session.id} agentStatus={stream.agentStatus} fresh={freshSession} />
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
