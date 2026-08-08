import { clsx } from 'clsx'
import { useEffect, type ReactNode } from 'react'

export function Avatar({
  name,
  color,
  size = 'md',
  pulsing = false,
  title,
}: {
  name: string
  color: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  pulsing?: boolean
  title?: string
}) {
  const sizes = { xs: 'h-5 w-5 text-[9px]', sm: 'h-6 w-6 text-[10px]', md: 'h-8 w-8 text-xs', lg: 'h-10 w-10 text-sm' }
  return (
    <div
      title={title ?? name}
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-ink-950 select-none',
        sizes[size],
        pulsing && 'animate-pulse-ring',
      )}
      style={{ backgroundColor: color }}
    >
      {initials(name)}
    </div>
  )
}

export function AvatarStack({ users, max = 5 }: { users: Array<{ name: string; avatarColor: string }>; max?: number }) {
  const shown = users.slice(0, max)
  return (
    <div className="flex -space-x-1.5">
      {shown.map((u, i) => (
        <div key={i} className="rounded-full ring-2 ring-ink-900">
          <Avatar name={u.name} color={u.avatarColor} size="sm" />
        </div>
      ))}
      {users.length > max && (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-700 text-[10px] text-ink-200 ring-2 ring-ink-900">
          +{users.length - max}
        </div>
      )}
    </div>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

export function StatusPill({ status }: { status: 'idea' | 'building' | 'stable' }) {
  const styles = {
    idea: 'bg-ink-700/60 text-ink-200 border-ink-500',
    building: 'bg-amber-500/10 text-amber-300 border-amber-500/40',
    stable: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40',
  }
  return <span className={clsx('chip border', styles[status])}>{status}</span>
}

export function AgentStatusIndicator({ status }: { status: 'thinking' | 'running_tools' | 'idle' | 'error' }) {
  if (status === 'thinking' || status === 'running_tools') {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-accent-soft">
        <span className="thinking-dots inline-flex gap-1">
          <span />
          <span />
          <span />
        </span>
        {status === 'thinking' ? 'thinking' : 'working'}
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" /> error
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-300">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> idle
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'h-5 w-5 animate-spin rounded-full border-2 border-ink-500 border-t-accent',
        className,
      )}
    />
  )
}

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="card relative w-full max-w-md p-6 animate-fade-in-up shadow-2xl shadow-black/50">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-ghost -mr-2 px-2 py-1 text-ink-400">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function SlideOver({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className={clsx(
          'absolute right-0 top-0 h-full overflow-y-auto border-l border-ink-700 bg-ink-900 shadow-2xl',
          wide ? 'w-full max-w-3xl' : 'w-full max-w-xl',
        )}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-ink-700 bg-ink-900/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0 flex-1">{title}</div>
          <button onClick={onClose} className="btn-ghost ml-3 px-2 py-1 text-ink-400">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function EmptyState({ emoji, title, hint, action }: { emoji: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-ink-600 px-6 py-12 text-center">
      <div className="text-3xl">{emoji}</div>
      <div className="text-sm font-medium text-ink-200">{title}</div>
      {hint && <div className="max-w-sm text-xs text-ink-400">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-red-900/60 bg-red-950/20 px-6 py-8 text-center">
      <div className="text-sm text-red-300">{message}</div>
      {onRetry && (
        <button className="btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card space-y-3 p-5">
      <div className="skeleton h-5 w-1/3" />
      {[...Array(lines - 1)].map((_, i) => (
        <div key={i} className="skeleton h-3.5" style={{ width: `${85 - i * 18}%` }} />
      ))}
    </div>
  )
}
