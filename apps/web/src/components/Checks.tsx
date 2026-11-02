import { Play } from 'lucide-react'
import { useState } from 'react'
import type { SessionEventOf } from '@loom/shared'
import { timeAgo, useNow } from '../lib/time'
import { Button, Spinner, cn } from './primitives'

type CheckRun = SessionEventOf<'check_run'>['payload']
type Plan = SessionEventOf<'plan'>['payload']

const STATUS_TILE: Record<CheckRun['status'], { text: string; cls: string }> = {
  passed: { text: 'Pass', cls: 'bg-ok text-on-accent' },
  warned: { text: 'Warn', cls: 'bg-warn text-on-accent' },
  failed: { text: 'Fail', cls: 'bg-signal-500 text-on-accent' },
}
const MARK: Record<'pass' | 'warn' | 'fail', { glyph: string; cls: string; sr: string }> = {
  pass: { glyph: '✓', cls: 'text-ok', sr: 'passed' },
  warn: { glyph: '!', cls: 'text-warn', sr: 'warning' },
  fail: { glyph: '✕', cls: 'text-danger', sr: 'failed' },
}

const SECONDS = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'second', unitDisplay: 'narrow', maximumFractionDigits: 1 })

const TRIGGER: Record<CheckRun['trigger'], string> = {
  commit: 'after a commit',
  manual: 'on demand',
  agent: 'to verify its work',
}

/** A check run as a printed report: verdict tile, then each check. */
export function ChecksReport({ run, at, compact = false }: { run: CheckRun; at?: string; compact?: boolean }) {
  const [showPasses, setShowPasses] = useState(false)
  const tile = STATUS_TILE[run.status]
  const problems = run.results.filter((r) => r.status !== 'pass')
  const passes = run.results.filter((r) => r.status === 'pass')
  const visible = showPasses || problems.length === 0 ? [...problems, ...passes] : problems
  return (
    <div className="max-w-[70ch] border border-hairline-strong bg-surface">
      <div className="flex items-stretch border-b border-hairline">
        <span className={cn('telemetry flex items-center px-2.5 font-bold', tile.cls)}>{tile.text}</span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2 px-3 py-1.5">
          <span className="text-small font-semibold text-primary">Checks</span>
          <span className="min-w-0 truncate text-small text-secondary">
            {run.byName} ran {run.results.length} {TRIGGER[run.trigger]}
          </span>
          <span className="telemetry ml-auto shrink-0 text-tertiary">
            {SECONDS.format(run.durationMs / 1000)}{at ? ` · ${timeAgo(at)}` : ''}
          </span>
        </div>
      </div>
      <ul className={cn('divide-y divide-hairline', compact && 'text-small')}>
        {visible.map((r) => (
          <li key={r.id} className="flex gap-2.5 px-3 py-1.5">
            <span aria-hidden className={cn('w-3 shrink-0 text-center font-mono font-bold', MARK[r.status].cls)}>
              {MARK[r.status].glyph}
            </span>
            <div className="min-w-0">
              <div className="text-small text-primary">
                {r.label}
                <span className="sr-only"> — {MARK[r.status].sr}</span>
              </div>
              {r.detail && r.status !== 'pass' && (
                <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-code-sm text-secondary">{r.detail}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {problems.length > 0 && passes.length > 0 && (
        <button
          type="button"
          onClick={() => setShowPasses((v) => !v)}
          aria-expanded={showPasses}
          className="telemetry w-full border-t border-hairline px-3 py-1 text-left text-tertiary hover:bg-raised hover:text-primary"
        >
          {showPasses ? 'Hide passing checks' : `+ ${passes.length} passed`}
        </button>
      )}
    </div>
  )
}

/** The agent's announced plan: numbered steps, the current one marked. */
export function PlanList({ plan, compact = false }: { plan: Plan; compact?: boolean }) {
  const done = plan.steps.filter((s) => s.status === 'done').length
  return (
    <div className="max-w-[70ch] border-l-2 border-hairline-strong pl-3">
      <div className="telemetry flex items-center gap-2 text-tertiary">
        <span className="text-primary">Plan</span>
        <span>
          {done}/{plan.steps.length} done
        </span>
      </div>
      <ol className={cn('mt-1 space-y-0.5', compact ? 'text-small' : 'text-ui')}>
        {plan.steps.map((s, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="tnum telemetry w-5 shrink-0 text-tertiary">{String(i + 1).padStart(2, '0')}</span>
            <span
              className={cn(
                'min-w-0',
                s.status === 'done' && 'text-tertiary line-through decoration-1',
                s.status === 'doing' && 'font-semibold text-primary',
                s.status === 'todo' && 'text-secondary',
              )}
            >
              {s.text}
            </span>
            {s.status === 'doing' && <span className="telemetry shrink-0 bg-signal-500 px-1 text-on-accent">Now</span>}
            {s.status === 'done' && <span className="sr-only">(done)</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * Docked under the test bench: the latest verdict, who is running checks
 * right now, and a button any member can press — everyone sees the result.
 */
export function ChecksDock({
  latest,
  checking,
  onRun,
}: {
  latest: SessionEventOf<'check_run'> | null
  checking: { byName: string } | null
  onRun?: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  useNow(15_000)
  const run = latest?.payload
  const tile = run ? STATUS_TILE[run.status] : null
  const problems = run ? run.results.filter((r) => r.status !== 'pass') : []
  return (
    <section aria-label="Checks" className="shrink-0 border-t-2 border-hairline-strong bg-surface">
      <div className="flex h-9 items-center gap-2 px-3">
        <span className="telemetry text-primary">Checks</span>
        {/* one persistent live region: the verdict is announced when a run lands */}
        <div aria-live="polite" className="contents">
        {checking ? (
          <span className="telemetry inline-flex items-center gap-1.5 text-secondary">
            <Spinner decorative className="h-3 w-3" /> {checking.byName} is running checks
          </span>
        ) : tile && run ? (
          <>
            <span className={cn('telemetry px-1.5 font-bold', tile.cls)}>{tile.text}</span>
            <span className="min-w-0 truncate text-small text-secondary" title={problems.map((p) => p.label).join(', ')}>
              {problems.length === 0 ? `${run.results.length} of ${run.results.length} ok` : problems.map((p) => p.label).join(' · ')}
            </span>
            <span className="telemetry shrink-0 text-tertiary">{latest ? timeAgo(latest.createdAt) : ''}</span>
          </>
        ) : (
          <span className="text-small text-tertiary">Not run yet</span>
        )}
        </div>
        {onRun && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            disabled={busy || Boolean(checking)}
            onClick={async () => {
              setBusy(true)
              try {
                await onRun()
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Spinner decorative className="h-3 w-3" /> : <Play size={12} strokeWidth={2} aria-hidden />}
            {busy ? 'Starting…' : 'Run checks'}
          </Button>
        )}
      </div>
    </section>
  )
}
