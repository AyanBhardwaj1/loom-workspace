import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ChangeSummary, PresenceUser, ProjectUpdate } from '@loom/shared'
import { wsClient } from '../lib/ws'

export interface ModuleActivity {
  sessionId: string
  driverUserId: string
  driverName: string
  gist: string
  at: string
}

export interface ProjectFeed {
  presence: PresenceUser[]
  /** latest live gist per module (dashboard liveness) */
  activityByModule: Map<string, ModuleActivity>
  /** 1.3 — rolling last-3 gists per session (mission-control tickers) */
  tickerBySession: Map<string, ModuleActivity[]>
  /** changes that arrived live during this page's lifetime, newest first */
  liveChanges: ChangeSummary[]
  /** ids of changes that just arrived (for the highlight animation) */
  freshChangeIds: Set<string>
  lastMerge: { branchName: string; ok: boolean; message: string } | null
}

/**
 * Project-level live feed: presence, per-module activity gists, new changes.
 * Also invalidates the relevant react-query caches so lists stay fresh.
 */
export function useProjectFeed(projectId: string | null): ProjectFeed {
  const queryClient = useQueryClient()
  const [presence, setPresence] = useState<PresenceUser[]>([])
  const [activityByModule, setActivityByModule] = useState<Map<string, ModuleActivity>>(new Map())
  const [tickerBySession, setTickerBySession] = useState<Map<string, ModuleActivity[]>>(new Map())
  const [liveChanges, setLiveChanges] = useState<ChangeSummary[]>([])
  const [freshChangeIds, setFreshChangeIds] = useState<Set<string>>(new Set())
  const [lastMerge, setLastMerge] = useState<ProjectFeed['lastMerge']>(null)
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!projectId) return
    setPresence([])
    setActivityByModule(new Map())
    setTickerBySession(new Map())
    setLiveChanges([])
    setFreshChangeIds(new Set())

    const invalidateProject = () => {
      // debounce: bursts of updates should not stampede the API
      if (invalidateTimer.current) clearTimeout(invalidateTimer.current)
      invalidateTimer.current = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['module-sessions'] })
      }, 350)
    }

    const handleUpdate = (update: ProjectUpdate) => {
      switch (update.kind) {
        case 'session_activity': {
          const activity: ModuleActivity = {
            sessionId: update.sessionId,
            driverUserId: update.driverUserId,
            driverName: update.driverName,
            gist: update.gist,
            at: update.at,
          }
          setActivityByModule((prev) => {
            const next = new Map(prev)
            next.set(update.moduleId, activity)
            return next
          })
          setTickerBySession((prev) => {
            const next = new Map(prev)
            const list = [...(next.get(update.sessionId) ?? []), activity].slice(-3)
            next.set(update.sessionId, list)
            return next
          })
          break
        }
        case 'change':
          setLiveChanges((prev) => [update.change, ...prev.filter((c) => c.id !== update.change.id)].slice(0, 30))
          setFreshChangeIds((prev) => new Set(prev).add(update.change.id))
          setTimeout(() => {
            setFreshChangeIds((prev) => {
              const next = new Set(prev)
              next.delete(update.change.id)
              return next
            })
          }, 2500)
          void queryClient.invalidateQueries({ queryKey: ['changes', projectId] })
          void queryClient.invalidateQueries({ queryKey: ['branches', projectId] })
          break
        case 'session_started':
        case 'session_ended':
          invalidateProject()
          break
        case 'module_updated':
          invalidateProject()
          break
        case 'merge':
          setLastMerge({ branchName: update.branchName, ok: update.ok, message: update.message })
          void queryClient.invalidateQueries({ queryKey: ['branches', projectId] })
          break
      }
    }

    const offMessage = wsClient.onMessage((msg) => {
      if (msg.t === 'presence' && msg.projectId === projectId) {
        setPresence(msg.users)
      } else if (msg.t === 'project_update' && msg.projectId === projectId) {
        handleUpdate(msg.update)
      }
    })
    // after a reconnect we may have missed project updates entirely — resync
    const offOpen = wsClient.onOpen(() => {
      invalidateProject()
      void queryClient.invalidateQueries({ queryKey: ['changes', projectId] })
      void queryClient.invalidateQueries({ queryKey: ['branches', projectId] })
    })
    const unsub = wsClient.subProject(projectId)

    return () => {
      offMessage()
      offOpen()
      unsub()
      if (invalidateTimer.current) clearTimeout(invalidateTimer.current)
    }
  }, [projectId, queryClient])

  return { presence, activityByModule, tickerBySession, liveChanges, freshChangeIds, lastMerge }
}
