import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { ProjectPolicy } from '@loom/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'

/** The room's rules for a project (merge gate, guarded actions, freeze), kept live. */
export function usePolicy(projectId: string | null) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['policy', projectId],
    queryFn: () => api.get<{ policy: ProjectPolicy; isOwner: boolean }>(`/api/projects/${projectId}/policy`),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  })
  // a teammate freezing/unfreezing reaches every open page at once
  useEffect(() => {
    if (!projectId) return
    return wsClient.onMessage((msg) => {
      if (msg.t === 'project_update' && msg.projectId === projectId && msg.update.kind === 'policy') {
        void qc.invalidateQueries({ queryKey: ['policy', projectId] })
      }
    })
  }, [projectId, qc])
  const update = async (patch: Partial<Pick<ProjectPolicy, 'mergeGate' | 'guardedActions' | 'protectedPaths' | 'frozen'>>) => {
    const res = await api.put<{ policy: ProjectPolicy; isOwner: boolean }>(`/api/projects/${projectId}/policy`, patch)
    qc.setQueryData(['policy', projectId], res)
    return res
  }
  return { policy: q.data?.policy ?? null, isOwner: q.data?.isOwner ?? false, update }
}
