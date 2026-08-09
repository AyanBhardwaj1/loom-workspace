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
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-ink-950 select-none ring-1 ring-inset ring-white/15',
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
    idea: 'border-white/10 bg-white/[0.05] text-ink-300',
    building: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
    stable: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  }
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5', styles[status])}>
      {status !== 'idea' && (
        <span
          className={clsx('h-1.5 w-1.5 rounded-full', status === 'building' ? 'bg-amber-400' : 'bg-emerald-400')}
        />
      )}
      <span className="micro-label !text-inherit">{status}</span>
    </span>
  )
}

/** A small status LED with a soft glow. */
function Led({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      {pulse && (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className="relative inline-flex h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 6px 0 ${color}` }}
      />
    </span>
  )
}

export function AgentStatusIndicator({ status }: { status: 'thinking' | 'running_tools' | 'idle' | 'error' }) {
  if (status === 'thinking' || status === 'running_tools') {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-accent-soft">
        <span className="thinking-dots">
          <span />
          <span />
          <span />
        </span>
        <span className="micro-label !text-accent-soft">{status === 'thinking' ? 'thinking' : 'working'}</span>
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
        <Led color="#f26d6d" /> <span className="micro-label !text-red-400">error</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-300">
      <Led color="#38e0a5" /> <span className="micro-label">idle</span>
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <div className={clsx('loader h-5 w-5', className)} />
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
      <div className="anim-overlay-in absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
      <div className="panel anim-dialog-in relative w-full max-w-md p-6 shadow-glass-lg">
        <div className="hairline absolute inset-x-6 top-0" />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
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
      <div className="anim-overlay-in absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div
        className={clsx(
          'anim-slide-in absolute right-0 top-0 h-full overflow-y-auto border-l border-white/10 bg-ink-950/95 shadow-glass-lg backdrop-blur-xl',
          wide ? 'w-full max-w-3xl' : 'w-full max-w-xl',
        )}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.07] bg-ink-950/80 px-5 py-4 backdrop-blur-xl">
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
    <div className="relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-dashed border-white/[0.09] bg-white/[0.015] px-6 py-14 text-center">
      {/* an idling thread woven behind the content */}
      <svg
        className="pointer-events-none absolute inset-x-0 top-0 h-full w-full opacity-[0.12]"
        preserveAspectRatio="none"
        viewBox="0 0 400 200"
        aria-hidden
      >
        <path d="M0 100 Q100 40 200 100 T400 100" fill="none" stroke="url(#eg)" strokeWidth="1.5" />
        <defs>
          <linearGradient id="eg" x1="0" x2="1">
            <stop offset="0" stopColor="#8b7cf6" stopOpacity="0" />
            <stop offset="0.5" stopColor="#38d6e0" />
            <stop offset="1" stopColor="#8b7cf6" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      <div className="relative text-3xl">{emoji}</div>
      <div className="relative text-sm font-medium text-ink-200">{title}</div>
      {hint && <div className="relative max-w-sm text-xs leading-relaxed text-ink-400">{hint}</div>}
      {action && <div className="relative mt-3">{action}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-red-500/25 bg-red-500/[0.06] px-6 py-8 text-center">
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
