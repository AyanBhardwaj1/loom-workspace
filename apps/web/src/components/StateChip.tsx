import type { SessionState } from '@loom/shared'
import { cn } from './primitives'

const LOOK: Record<SessionState, { label: string; cls: string; pulse?: boolean }> = {
  'awaiting-approval': { label: 'Needs approval', cls: 'bg-warn text-on-accent', pulse: true },
  working: { label: 'Working', cls: 'bg-signal-500 text-on-accent', pulse: true },
  checking: { label: 'Checking', cls: 'bg-primary text-canvas', pulse: true },
  'needs-testing': { label: 'Needs testing', cls: 'bg-warn text-on-accent' },
  'your-move': { label: 'Your move', cls: 'bg-primary text-canvas' },
  error: { label: 'Error', cls: 'bg-signal-600 text-on-accent' },
  idle: { label: 'Idle', cls: 'border border-hairline-strong text-secondary' },
  stale: { label: 'Stale', cls: 'border border-dashed border-hairline-strong text-tertiary' },
  ended: { label: 'Ended', cls: 'border border-hairline-strong text-tertiary' },
}

/** The session's derived lifecycle state + what it is doing, as one telemetry chip. */
export function StateChip({ state, detail, className, compact = false }: { state: SessionState; detail: string; className?: string; compact?: boolean }) {
  const look = LOOK[state]
  return (
    <span role="status" className={cn('inline-flex min-w-0 items-center gap-2', className)} title={detail}>
      <span className={cn('telemetry inline-flex h-5 shrink-0 items-center gap-1.5 px-1.5 font-bold', look.cls)}>
        {look.pulse && <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-current" />}
        {look.label}
      </span>
      {!compact && <span className="hidden min-w-0 truncate font-mono text-code-sm text-secondary sm:inline">{detail}</span>}
      {compact && <span className="sr-only">{detail}</span>}
    </span>
  )
}
