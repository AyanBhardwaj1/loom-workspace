import { cva, type VariantProps } from 'class-variance-authority'
import { clsx, type ClassValue } from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { extendTailwindMerge } from 'tailwind-merge'
import { UnitMark } from './Wordmark'
import { identityColor } from '../lib/identity'

/**
 * tailwind-merge must know the role-named type scale: otherwise it reads
 * `text-ui` as a text COLOR and silently drops the real color beside it
 * (every primary button lost its dark on-accent text that way).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'small', 'ui', 'body', 'h4', 'h3', 'h2', 'display', 'code', 'code-sm'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/* ----------------------------------------------------------------------------
 * Button — primary (lavender, dark text) / outline / ghost / danger
 * Routine interaction is CSS-only and nearly instant (--t-micro/fast).
 * ------------------------------------------------------------------------- */
export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-semibold uppercase tracking-[0.04em] transition-[color,background-color,border-color,transform] duration-micro ease-standard active:translate-y-px disabled:pointer-events-none disabled:text-disabled',
  {
    variants: {
      variant: {
        // ink slab; the one place red appears on a resting control is hover/press
        primary:
          'bg-primary text-canvas hover:bg-signal-500 hover:text-on-accent active:bg-signal-600 disabled:bg-raised',
        outline:
          'border border-hairline-strong bg-surface text-primary hover:bg-primary hover:text-canvas active:bg-signal-500 active:text-on-accent',
        ghost: 'text-secondary hover:bg-raised hover:text-primary active:bg-inset',
        danger:
          'border border-danger-border text-danger hover:bg-danger hover:text-on-accent active:bg-signal-600',
      },
      size: {
        sm: 'h-7 px-2.5 text-[11px]',
        md: 'h-8 px-3.5 text-small',
        lg: 'h-10 px-5 text-ui',
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
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-[color,background-color,transform] duration-micro hover:bg-raised hover:text-primary active:translate-y-px disabled:pointer-events-none disabled:text-disabled [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10',
        className,
      )}
      {...props}
    />
  )
})

/* ----------------------------------------------------------------------------
 * Pills & chips
 * ------------------------------------------------------------------------- */
export function LivePill({ label = 'Live', className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        'telemetry inline-flex h-5 items-center gap-1.5 bg-signal-500 px-1.5 text-on-accent',
        className,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 animate-soft-pulse bg-on-accent" />
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
    neutral: 'text-secondary',
    ok: 'text-ok',
    warn: 'text-warn',
    danger: 'text-danger',
    accent: 'text-signal-300',
  }
  // a bracketed telemetry tag: [ BUILDING ]
  return (
    // brackets are drawn, not text (and given empty alt text, so screen readers skip them) —
    // the label's text content stays exactly its words
    <span
      className={cn(
        "telemetry inline-flex h-5 items-center gap-1 whitespace-nowrap before:content-['['_/_''] after:content-[']'_/_'']",
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
 * Page structure — one heading voice for every screen
 * ------------------------------------------------------------------------- */
/** Sentence-case section label (replaces the old all-caps micro labels). */
export function SectionLabel({
  children,
  className,
  as: Tag = 'h2',
}: {
  children: ReactNode
  className?: string
  as?: 'h2' | 'h3' | 'div'
}) {
  // telemetry label ruled to the edge: LIVE NOW ————————
  return (
    <Tag className={cn('telemetry flex items-center gap-2 text-secondary after:h-px after:flex-1 after:bg-hairline', className)}>
      {children}
    </Tag>
  )
}

/** Page title block: display heading, one line of context, actions on the right. */
export function PageHeader({
  title,
  meta,
  actions,
  className,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b-2 border-hairline-strong pb-4', className)}>
      <div className="min-w-0">
        <h1 className="font-display text-balance text-display text-primary">{title}</h1>
        {meta && <div className="telemetry mt-3 text-secondary">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
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
          'border border-hairline-strong bg-surface',
          interactive &&
            'transition-[background-color,box-shadow,transform] duration-fast ease-standard hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_0_var(--text-primary)] motion-reduce:hover:translate-x-0 motion-reduce:hover:translate-y-0',
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
      role="img"
      aria-label={title ?? name}
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold', sizes[size], className)}
      style={{ backgroundColor: identityColor(color), color: 'var(--text-on-identity)' }}
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
  ariaLabel,
}: {
  options: Array<{ value: T; label: ReactNode; title?: string }>
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  className?: string
  /** names the group for assistive tech ("Provider", "Effort"…) */
  ariaLabel?: string
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )
  // radio-group keyboard model: arrows move AND select; one tab stop for the group
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    const next = options[(idx + delta + options.length) % options.length]!
    onChange(next.value)
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons[(idx + delta + options.length) % options.length]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn('relative inline-flex rounded border border-hairline bg-inset p-0.5', className)}
    >
      <span
        aria-hidden
        className="absolute bottom-0.5 top-0.5 rounded-[4px] bg-signal-500 transition-transform duration-micro ease-standard"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${idx * 100}%)`,
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          type="button"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative z-0 min-w-0 flex-1 truncate whitespace-nowrap rounded-[4px] font-medium transition-colors duration-micro',
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
/** 9.1 — the weave loader: three threads crossing instead of a generic ring. */
export function Spinner({ className, decorative = false }: { className?: string; /** inside a parent that already announces */ decorative?: boolean }) {
  return (
    <span
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : 'Loading'}
      aria-hidden={decorative || undefined}
      className={cn('inline-block h-4 w-4', className)}
    >
      <svg viewBox="0 0 16 16" className="weave-spinner h-full w-full" fill="none" aria-hidden>
        <line x1="1" y1="5" x2="15" y2="5" stroke="var(--signal-500)" strokeWidth="1.5" />
        <line x1="1" y1="8" x2="15" y2="8" stroke="var(--hairline-strong)" strokeWidth="1.5" />
        <line x1="1" y1="11" x2="15" y2="11" stroke="var(--signal-300)" strokeWidth="1.5" />
      </svg>
    </span>
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
      <UnitMark size={22} className="text-primary opacity-25" />
      <div className="text-ui font-medium text-secondary">{title}</div>
      {hint && <div className="max-w-sm text-small text-tertiary">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/** Errors state what happened and the next step. Never "Oops". */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 border border-danger-border bg-danger-fill px-6 py-8 text-center">
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
    accent: 'bg-signal-500',
    idle: 'bg-hairline-strong',
  }
  return <span aria-hidden className={cn('inline-block h-1.5 w-1.5 rounded-full', tones[tone], className)} />
}
