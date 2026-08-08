import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ProjectDetail } from '@loom/shared'
import { api } from '../lib/api'
import { useSessionStream } from '../state/useSessionStream'
import { ChatLog } from './ChatLog'
import { AgentStatusIndicator, Avatar, Spinner } from './ui'

/**
 * The product's signature moment: watch a teammate's live agent session in a
 * sidebar next to your own, and fork from any point of their stream.
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
  const [forking, setForking] = useState(false)

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

  const stream = useSessionStream(selectedId)
  const selected = candidates.find((s) => s.id === selectedId) ?? null

  const fork = async (atEventId?: string) => {
    if (!selectedId || forking) return
    setForking(true)
    try {
      const res = await api.post<{ session: { id: string } }>(`/api/sessions/${selectedId}/fork`, {
        atEventId,
      })
      navigate(`/p/${projectId}/s/${res.session.id}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Fork failed')
    } finally {
      setForking(false)
    }
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-ink-700 bg-ink-900/60 xl:w-96">
      <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-300">👁 Spectate</span>
        <button onClick={onClose} className="ml-auto text-ink-400 hover:text-ink-100" title="Hide sidebar">
          ✕
        </button>
      </div>

      {candidates.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="text-2xl">🕸</div>
          <div className="text-xs text-ink-300">No other live sessions right now.</div>
          <div className="text-[11px] text-ink-400">
            When a teammate starts building, pick their session here and watch it stream.
          </div>
        </div>
      ) : (
        <>
          <div className="border-b border-ink-700 px-3 py-2">
            <select
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
              className="input py-1.5 text-xs"
            >
              {candidates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.driverName} — {s.title}
                </option>
              ))}
            </select>
            {selected && (
              <div className="mt-2 flex items-center gap-2">
                <Avatar name={selected.driverName} color={selected.driverAvatarColor} size="sm" pulsing />
                <span className="truncate text-xs text-ink-200">{selected.driverName} is driving</span>
                <span className="ml-auto">
                  <AgentStatusIndicator status={stream.agentStatus} />
                </span>
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
              driverColor={selected?.driverAvatarColor ?? '#8b7cf6'}
              compact
              onFork={(eventId) => void fork(eventId)}
              emptyHint="Waiting for activity…"
            />
          )}

          <div className="border-t border-ink-700 p-3">
            <button onClick={() => void fork()} disabled={forking || !selectedId} className="btn-secondary w-full text-xs">
              {forking ? 'Forking…' : '⑂ Fork & continue from latest'}
            </button>
            <div className="mt-1.5 text-center text-[10px] text-ink-400">
              You get their conversation + code, they keep working uninterrupted
            </div>
          </div>
        </>
      )}
    </div>
  )
}
