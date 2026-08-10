import NumberFlow from '@number-flow/react'
import { ChevronsLeft, ChevronsRight, GitFork, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ProjectDetail } from '@loom/shared'
import { api } from '../lib/api'
import { useProjectFeed } from '../state/useProjectFeed'
import { useSessionStream } from '../state/useSessionStream'
import { ChatLog } from './ChatLog'
import { Avatar, Button, IconButton, LivePill, Spinner, StatusDot, cn } from './primitives'

const NUMBER_TIMING: EffectTiming = { duration: 180, easing: 'cubic-bezier(0.2,0,0,1)' }

/**
 * VII.5 — watch a teammate's live session beside your own; fork from any
 * point of their stream. Same event components at spectate density.
 */
export function SpectatorSidebar({
  projectId,
  currentSessionId,
  onClose,
}: {
  projectId: string
  currentSessionId: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('loom.spectate.collapsed') === '1')
  const [forking, setForking] = useState(false)
  const feed = useProjectFeed(projectId)

  useEffect(() => {
    localStorage.setItem('loom.spectate.collapsed', collapsed ? '1' : '0')
  }, [collapsed])

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${projectId}`),
    refetchInterval: 20_000,
  })

  const candidates = useMemo(
    () => (projectQuery.data?.activeSessions ?? []).filter((s) => s.id !== currentSessionId),
    [projectQuery.data, currentSessionId],
  )

  useEffect(() => {
    if (selectedId && !candidates.some((s) => s.id === selectedId)) setSelectedId(null)
    if (!selectedId && candidates.length > 0) setSelectedId(candidates[0]!.id)
  }, [candidates, selectedId])

  const stream = useSessionStream(collapsed ? null : selectedId)
  const selected = candidates.find((s) => s.id === selectedId) ?? null
  const watcherCount = useMemo(
    () => feed.presence.filter((p) => p.viewing === selectedId).length,
    [feed.presence, selectedId],
  )

  const fork = async (atEventId?: string) => {
    if (!selectedId || forking) return
    setForking(true)
    try {
      const res = await api.post<{ session: { id: string } }>(`/api/sessions/${selectedId}/fork`, { atEventId })
      navigate(`/p/${projectId}/s/${res.session.id}`)
    } catch {
      setForking(false)
    }
  }

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center gap-3 border-l border-hairline bg-surface py-3">
        <IconButton label="Expand spectate" onClick={() => setCollapsed(false)}>
          <ChevronsLeft size={15} strokeWidth={1.5} />
        </IconButton>
        {selected && (
          <div className="relative" title={`${selected.driverName} is driving`}>
            <Avatar name={selected.driverName} color={selected.driverAvatarColor} size="md" />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-lav-500 ring-2 ring-surface" aria-hidden />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col border-l border-hairline bg-surface">
      {/* sticky header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-3">
        {selected ? (
          <>
            <Avatar name={selected.driverName} color={selected.driverAvatarColor} size="sm" />
            <span className="min-w-0 truncate text-ui font-medium text-primary">{selected.driverName}</span>
            <LivePill />
            <span className="min-w-0 flex-1 truncate text-small text-tertiary">{selected.title}</span>
          </>
        ) : (
          <span className="text-micro uppercase tracking-[0.08em] text-tertiary">Spectate</span>
        )}
        <IconButton label="Collapse to rail" onClick={() => setCollapsed(true)} className="ml-auto">
          <ChevronsRight size={15} strokeWidth={1.5} />
        </IconButton>
        <IconButton label="Hide spectate" onClick={onClose}>
          <X size={15} strokeWidth={1.5} />
        </IconButton>
      </div>

      {candidates.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
          <div className="text-ui text-secondary">No other live sessions right now.</div>
          <div className="text-small text-tertiary">When a teammate starts building, pick their session here and watch it stream.</div>
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-hairline px-3 py-2">
            <select value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)} className="loom-input py-1.5 text-small">
              {candidates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.driverName} — {s.title}
                </option>
              ))}
            </select>
            {selected && (
              <div className="mt-2 flex items-center gap-2 text-small text-secondary">
                <StatusDot tone={stream.agentStatus === 'thinking' || stream.agentStatus === 'running_tools' ? 'accent' : 'idle'} />
                {stream.agentStatus === 'thinking' ? 'thinking' : stream.agentStatus === 'running_tools' ? 'working' : 'idle'}
                {watcherCount > 0 && (
                  <span className="tnum ml-auto inline-flex items-center gap-1 font-mono text-small text-tertiary">
                    <NumberFlow value={watcherCount} transformTiming={NUMBER_TIMING} spinTiming={NUMBER_TIMING} /> watching
                  </span>
                )}
              </div>
            )}
          </div>

          {stream.loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <ChatLog
              events={stream.events}
              streamingText={stream.streamingText}
              agentStatus={stream.agentStatus}
              driverName={selected?.driverName ?? 'Driver'}
              driverColor={selected?.driverAvatarColor ?? 'var(--lav-500)'}
              compact
              onFork={(eventId) => void fork(eventId)}
              emptyHint="Waiting for activity…"
            />
          )}

          <div className="relative shrink-0 border-t border-hairline p-3">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 -top-2 h-2" style={{ background: 'linear-gradient(transparent, var(--bg-surface))' }} />
            <Button variant="primary" className="w-full" size="md" onClick={() => void fork()} disabled={forking || !selectedId}>
              <GitFork size={14} strokeWidth={1.5} />
              {forking ? 'Forking…' : 'Fork & continue'}
            </Button>
            <div className="mt-1.5 text-center text-small text-tertiary">
              You get their conversation + code; they keep working uninterrupted
            </div>
          </div>
        </>
      )}
    </div>
  )
}
