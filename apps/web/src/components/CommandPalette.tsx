import { Command } from 'cmdk'
import {
  CircleDot,
  Eye,
  FlaskConical,
  GitFork,
  History,
  LayoutGrid,
  MonitorPlay,
  Play,
  Search,
  Settings,
  SquareTerminal,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ProjectDetail, ProjectSummary, SessionSummary } from '@loom/shared'
import { api } from '../lib/api'
import { useAuth } from '../state/auth'

/** Open the AI-provider settings from anywhere (TopBar listens). */
export function openSettings(): void {
  window.dispatchEvent(new CustomEvent('loom:settings'))
}

/**
 * F1 — the ⌘K palette. Projects, live sessions, and context-aware actions.
 * cmdk underneath; every pixel from tokens.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { devMode } = useAuth()

  const projectId = useMemo(() => /^\/p\/([^/]+)/.exec(location.pathname)?.[1] ?? null, [location.pathname])
  const sessionId = useMemo(() => /\/s\/([^/]+)/.exec(location.pathname)?.[1] ?? null, [location.pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('loom:palette', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('loom:palette', onOpen)
    }
  }, [])

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: ProjectSummary[] }>('/api/projects'),
    enabled: open,
  })
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${projectId}`),
    enabled: open && Boolean(projectId),
  })

  const go = useCallback(
    (to: string) => {
      setOpen(false)
      navigate(to)
    },
    [navigate],
  )

  const run = useCallback(async (fn: () => Promise<void> | void) => {
    setOpen(false)
    await fn()
  }, [])

  const detail = projectQuery.data
  const liveSessions: SessionSummary[] = detail?.activeSessions ?? []

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter
      loop
      overlayClassName="modal-scrim fixed inset-0 z-scrim bg-scrim"
      contentClassName="palette-panel fixed left-1/2 top-[20vh] z-modal w-full max-w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-hairline bg-overlay shadow-modal"
    >
      <div className="flex items-center gap-2.5 border-b border-hairline px-3.5">
        <Search size={16} strokeWidth={1.5} className="shrink-0 text-tertiary" />
        <Command.Input
          placeholder="Search or jump to…"
          className="h-11 w-full bg-transparent text-body text-primary outline-none placeholder:text-tertiary"
        />
      </div>
      <Command.List className="max-h-[min(420px,50vh)] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-8 text-center text-small text-tertiary">
          Nothing matches. Try a project, session, or action name.
        </Command.Empty>

        {liveSessions.length > 0 && (
          <Group heading="Live sessions">
            {liveSessions.map((s) => (
              <Row
                key={s.id}
                value={`watch ${s.driverName} ${s.title}`}
                onSelect={() => go(`/p/${detail!.id}/s/${s.id}`)}
                icon={<CircleDot size={16} strokeWidth={1.5} className="text-lav-400" />}
              >
                <span className="min-w-0 truncate">
                  {s.title} <span className="text-tertiary">— {s.driverName}</span>
                </span>
                <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-lav-500" aria-hidden />
              </Row>
            ))}
          </Group>
        )}

        {projectId && detail && (
          <Group heading="Actions">
            {detail.modules.map((m) => (
              <Row
                key={m.id}
                value={`start session in ${m.name}`}
                onSelect={() =>
                  void run(async () => {
                    const res = await api.post<{ session: { id: string } }>(`/api/modules/${m.id}/sessions`, {})
                    navigate(`/p/${projectId}/s/${res.session.id}`)
                  })
                }
                icon={<SquareTerminal size={16} strokeWidth={1.5} />}
              >
                Start session in {m.emoji} {m.name}
              </Row>
            ))}
            {liveSessions.slice(0, 6).map((s) => (
              <Row
                key={`fork-${s.id}`}
                value={`fork ${s.title} ${s.driverName}`}
                onSelect={() =>
                  void run(async () => {
                    const res = await api.post<{ session: { id: string } }>(`/api/sessions/${s.id}/fork`, {})
                    navigate(`/p/${projectId}/s/${res.session.id}`)
                  })
                }
                icon={<GitFork size={16} strokeWidth={1.5} />}
              >
                Fork {s.title}
              </Row>
            ))}
            {sessionId && (
              <Row
                value="replay this session from start"
                onSelect={() => go(`/replay/${sessionId}`)}
                icon={<Play size={16} strokeWidth={1.5} />}
              >
                Replay this session
              </Row>
            )}
            {sessionId && (
              <Row
                value="export session as markdown download"
                onSelect={() =>
                  void run(() => {
                    window.dispatchEvent(new CustomEvent('loom:export'))
                  })
                }
                icon={<SquareTerminal size={16} strokeWidth={1.5} />}
              >
                Export session as Markdown
              </Row>
            )}
            <Row value="open version history" onSelect={() => go(`/p/${projectId}/history`)} icon={<History size={16} strokeWidth={1.5} />}>
              Open version history
            </Row>
            <Row value="open dashboard" onSelect={() => go(`/p/${projectId}`)} icon={<LayoutGrid size={16} strokeWidth={1.5} />}>
              Open dashboard
            </Row>
            <Row
              value="preview merged main"
              onSelect={() => go(`/p/${projectId}/history`)}
              icon={<MonitorPlay size={16} strokeWidth={1.5} />}
            >
              Preview main <span className="text-tertiary">(from history)</span>
            </Row>
            {devMode && (
              <Row
                value="simulate teammate ghost"
                onSelect={() => void run(() => api.post('/api/dev/ghost', { projectId }).then(() => undefined))}
                icon={<FlaskConical size={16} strokeWidth={1.5} />}
              >
                Simulate teammate
              </Row>
            )}
          </Group>
        )}

        <Group heading="Projects">
          {(projectsQuery.data?.projects ?? []).map((p) => (
            <Row
              key={p.id}
              value={`project ${p.name}`}
              onSelect={() => go(`/p/${p.id}`)}
              icon={<LayoutGrid size={16} strokeWidth={1.5} />}
            >
              <span className="min-w-0 truncate">{p.name}</span>
              {p.activeSessionCount > 0 && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-lav-500" aria-hidden />}
            </Row>
          ))}
        </Group>

        <Group heading="App">
          <Row value="ai provider settings api key" onSelect={() => void run(() => openSettings())} icon={<Settings size={16} strokeWidth={1.5} />}>
            AI provider settings
          </Row>
          <Row value="watch spectate live sessions all projects" onSelect={() => go('/')} icon={<Eye size={16} strokeWidth={1.5} />}>
            All projects
          </Row>
        </Group>
      </Command.List>
      <div className="flex items-center gap-3 border-t border-hairline px-3.5 py-2 text-small text-tertiary">
        <span className="inline-flex items-center gap-1">
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd>↵</kbd> open
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd>esc</kbd> close
        </span>
      </div>
    </Command.Dialog>
  )
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-tertiary"
    >
      {children}
    </Command.Group>
  )
}

function Row({
  value,
  onSelect,
  icon,
  children,
}: {
  value: string
  onSelect: () => void
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="relative flex h-9 cursor-pointer select-none items-center gap-2.5 rounded px-2.5 text-ui text-secondary data-[selected=true]:bg-lav-fill data-[selected=true]:text-primary"
    >
      {/* 2px lavender left rule on the selected row (display toggled in index.css) */}
      <span aria-hidden className="palette-rule absolute bottom-1 left-0 top-1 w-[2px] rounded-full bg-lav-500" />
      <span className="shrink-0 text-tertiary">{icon}</span>
      {children}
    </Command.Item>
  )
}
