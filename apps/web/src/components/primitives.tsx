import { cva, type VariantProps } from 'class-variance-authority'
import { clsx, type ClassValue } from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { twMerge } from 'tailwind-merge'
import { WovenMark } from './Wordmark'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/* ----------------------------------------------------------------------------
 * Button — primary (lavender, dark text) / outline / ghost / danger
 * Routine interaction is CSS-only and nearly instant (--t-micro/fast).
 * ------------------------------------------------------------------------- */
const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium transition-colors duration-micro ease-standard disabled:pointer-events-none disabled:text-disabled',
  {
    variants: {
      variant: {
        primary:
          'bg-lav-500 text-on-accent hover:bg-lav-400 active:bg-lav-600 disabled:bg-raised',
        outline:
          'border border-hairline bg-transparent text-primary hover:border-hairline-hover hover:bg-raised active:bg-overlay',
        ghost: 'text-secondary hover:bg-raised hover:text-primary active:bg-overlay',
        danger:
          'border border-hairline text-danger hover:border-danger-border hover:bg-danger-fill active:bg-danger-fill',
      },
      size: {
        sm: 'h-7 px-2.5 text-small',
        md: 'h-8 px-3 text-ui',
        lg: 'h-9 px-3.5 text-ui',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type, ...props },
  ref,
) {
  return <button ref={ref} type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})

/** 28px square ghost button for icon-only actions. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string }
>(function IconButton({ className, label, type, ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary disabled:pointer-events-none disabled:text-disabled',
        className,
      )}
      {...props}
    />
  )
})

/* ----------------------------------------------------------------------------
 * Pills & chips
 * ------------------------------------------------------------------------- */
export function LivePill({ label = 'LIVE', className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center rounded-full bg-lav-500 px-2 text-micro uppercase tracking-[0.08em] text-on-accent',
        className,
      )}
    >
      {label}
    </span>
  )
}

export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'
  className?: string
}) {
  const tones = {
    neutral: 'text-secondary border-hairline',
    ok: 'text-ok border-ok-border',
    warn: 'text-warn border-warn-border',
    danger: 'text-danger border-danger-border',
    accent: 'text-lav-300 border-lav-border',
  }
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center gap-1 rounded-full border px-2 text-micro uppercase tracking-[0.08em]',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Mono data chip — paths, SHAs, branch names. */
export function MonoChip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'tnum inline-flex max-w-full items-center gap-1 truncate rounded bg-inset px-1.5 py-0.5 font-mono text-code-sm text-secondary',
        'border border-hairline',
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ----------------------------------------------------------------------------
 * Card — flat surface + hairline; never nested in another card
 * ------------------------------------------------------------------------- */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { interactive?: boolean }>(
  function Card({ className, interactive, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg border border-hairline bg-surface',
          interactive &&
            'transition-colors duration-fast ease-standard hover:border-hairline-hover hover:bg-raised',
          className,
        )}
        {...props}
      />
    )
  },
)

/* ----------------------------------------------------------------------------
 * Avatar — founder identity colors carry the person; initials in near-black
 * ------------------------------------------------------------------------- */
export function Avatar({
  name,
  color,
  size = 'md',
  className,
  title,
}: {
  name: string
  color: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
  title?: string
}) {
  const sizes = {
    xs: 'h-4 w-4 text-[8px]',
    sm: 'h-5 w-5 text-[9px]',
    md: 'h-6 w-6 text-[10px]',
    lg: 'h-8 w-8 text-small',
  }
  return (
    <span
      title={title ?? name}
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold', sizes[size], className)}
      style={{ backgroundColor: color, color: 'var(--text-on-identity)' }}
    >
      {initials(name)}
    </span>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

export function AvatarStack({
  users,
  max = 5,
  size = 'md',
}: {
  users: Array<{ name: string; avatarColor: string }>
  max?: number
  size?: 'xs' | 'sm' | 'md'
}) {
  const shown = users.slice(0, max)
  const overlap = size === 'xs' ? '-space-x-1' : '-space-x-2'
  return (
    <div className={cn('flex items-center', overlap)}>
      {shown.map((u, i) => (
        <span key={i} className="rounded-full ring-1 ring-canvas">
          <Avatar name={u.name} color={u.avatarColor} size={size} />
        </span>
      ))}
      {users.length > max && (
        <span className="tnum z-0 ml-1 font-mono text-small text-tertiary">+{users.length - max}</span>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * SegmentedControl — 6px segments, active = lavender fill + dark text
 * ------------------------------------------------------------------------- */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
}: {
  options: Array<{ value: T; label: ReactNode; title?: string }>
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  className?: string
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )
  return (
    <div
      role="tablist"
      className={cn('relative inline-flex rounded border border-hairline bg-inset p-0.5', className)}
    >
      <span
        aria-hidden
        className="absolute bottom-0.5 top-0.5 rounded-[4px] bg-lav-500 transition-transform duration-micro ease-standard"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${idx * 100}%)`,
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative z-0 flex-1 whitespace-nowrap rounded-[4px] font-medium transition-colors duration-micro',
            size === 'sm' ? 'px-2 py-0.5 text-small' : 'px-2.5 py-1 text-small',
            o.value === value ? 'text-on-accent' : 'text-secondary hover:text-primary',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Feedback & meta-states
 * ------------------------------------------------------------------------- */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border border-hairline-strong border-t-lav-500',
        className,
      )}
      style={{ animationDuration: '0.8s' }}
    />
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4', className)} aria-hidden />
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-3 rounded-lg border border-hairline bg-surface p-4">
      <Skeleton className="h-4 w-1/3" />
      {[...Array(lines - 1)].map((_, i) => (
        <div key={i} className="skeleton h-3" style={{ width: `${82 - i * 16}%` }} aria-hidden />
      ))}
    </div>
  )
}

/** Empty states: the woven mark small and dim, one plain sentence, one action. */
export function EmptyState({
  title,
  hint,
  action,
  className,
}: {
  title: string
  hint?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-14 text-center', className)}>
      <WovenMark size={24} className="text-primary opacity-20" />
      <div className="text-ui font-medium text-secondary">{title}</div>
      {hint && <div className="max-w-sm text-small text-tertiary">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/** Errors state what happened and the next step. Never "Oops". */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-danger-border bg-danger-fill px-6 py-8 text-center">
      <div className="text-ui text-danger">{message}</div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Status dot — liveness LED without glow (glow is reserved for live cards)
 * ------------------------------------------------------------------------- */
export function StatusDot({ tone, className }: { tone: 'ok' | 'warn' | 'danger' | 'accent' | 'idle'; className?: string }) {
  const tones = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    danger: 'bg-danger',
    accent: 'bg-lav-500',
    idle: 'bg-hairline-strong',
  }
  return <span aria-hidden className={cn('inline-block h-1.5 w-1.5 rounded-full', tones[tone], className)} />
}
