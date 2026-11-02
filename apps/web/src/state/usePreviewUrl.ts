import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * A signed, short-lived URL for the sandboxed preview frame. The frame's
 * opaque origin means the browser never sends our cookie with its asset
 * requests, so the capability rides in the path instead (server:
 * routes/preview.ts). Refreshed well before the server's 8h expiry.
 */
export function usePreviewUrl(target: { session: string } | { main: string } | { live: string } | null): string | null {
  const key = target ? ('session' in target ? `session=${target.session}` : 'main' in target ? `main=${target.main}` : `live=${target.live}`) : null
  const q = useQuery({
    queryKey: ['preview-url', key],
    queryFn: () => api.get<{ url: string }>(`/api/preview-url?${key}`),
    enabled: key !== null,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 2 * 60 * 60 * 1000,
  })
  return q.data?.url ?? null
}
