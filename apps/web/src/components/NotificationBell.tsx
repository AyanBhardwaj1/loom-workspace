import { Bell } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { NotificationDto } from '@loom/shared'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'
import { wsClient } from '../lib/ws'
import { Popover, PopoverContent, PopoverTrigger } from './overlay'
import { Button, cn } from './primitives'

/**
 * F13 — the bell: a 6px lavender dot when unread (no screaming badge counts),
 * dropdown of 40px rows, live arrivals also surface as toasts.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const now = useNow(30_000)

  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ notifications: NotificationDto[] }>('/api/notifications'),
    refetchInterval: 60_000,
  })
  const notifications = query.data?.notifications ?? []
  const unread = notifications.some((n) => !n.readAt)

  // live push: refresh the list + toast the arrival
  useEffect(() => {
    return wsClient.onMessage((msg) => {
      if (msg.t !== 'notification') return
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
      toast(msg.notification.text)
    })
  }, [queryClient])

  const openList = async (next: boolean) => {
    setOpen(next)
    if (next && unread) {
      // reading the list clears the dot
      await api.post('/api/notifications/read-all')
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
    }
  }

  return (
    <Popover open={open} onOpenChange={(v) => void openList(v)}>
      <PopoverTrigger asChild>
        <button
          title="Notifications"
          className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary"
        >
          <Bell size={16} strokeWidth={1.5} />
          {unread && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-lav-500" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex h-9 items-center justify-between border-b border-hairline px-3">
          <span className="text-micro uppercase tracking-[0.08em] text-tertiary">Notifications</span>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="px-3 py-8 text-center text-small text-tertiary">
              Forks, merges and reactions on your work land here.
            </div>
          ) : (
            notifications.map((n, i) => (
              <button
                key={n.id}
                onClick={() => {
                  setOpen(false)
                  if (n.projectId && n.sessionId) navigate(`/p/${n.projectId}/s/${n.sessionId}`)
                  else if (n.projectId) navigate(`/p/${n.projectId}`)
                }}
                className={cn(
                  'flex h-11 w-full items-center gap-2.5 px-3 text-left transition-colors duration-micro hover:bg-raised',
                  i > 0 && 'border-t border-hairline',
                )}
              >
                <span
                  aria-hidden
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', n.readAt ? 'bg-hairline-strong' : 'bg-lav-500')}
                />
                <span className="min-w-0 flex-1 truncate text-small text-primary">{n.text}</span>
                <span className="tnum shrink-0 font-mono text-small text-tertiary">{timeAgo(n.createdAt, now)}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
