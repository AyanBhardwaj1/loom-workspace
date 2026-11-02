import { useId, useState } from 'react'
import type { SessionEventOf } from '@loom/shared'
import { latestVerdicts } from './eventStream'
import { Button, cn } from './primitives'

type Plan = SessionEventOf<'test_plan'>
type Verdict = SessionEventOf<'test_verdict'>
type CaseState = 'untested' | 'pass' | 'fail'

/** a case fails if anyone's latest verdict is a fail; passes once someone passed it and nobody failed it */
function caseState(vs: Verdict[] | undefined): CaseState {
  if (!vs || vs.length === 0) return 'untested'
  return vs.some((v) => v.payload.verdict === 'fail') ? 'fail' : 'pass'
}

const MARK: Record<CaseState, { glyph: string; cls: string; sr: string }> = {
  untested: { glyph: '○', cls: 'text-tertiary', sr: 'not tested yet' },
  pass: { glyph: '✓', cls: 'text-ok', sr: 'passing' },
  fail: { glyph: '✕', cls: 'text-danger', sr: 'failing' },
}

/**
 * The agent's acceptance tests, verified by people in the live preview.
 * Automated verdicts on agent-built UIs are unreliable, so the team's
 * pass/fail is the evidence — and failures flow back to the agent.
 */
export function TestCases({
  plan,
  verdicts,
  onVerdict,
  onOpenBench,
  compact = false,
  latestCommitSeq = 0,
}: {
  plan: Plan
  verdicts: Verdict[]
  /** verdicts given before this commit describe code that has since moved */
  latestCommitSeq?: number
  onVerdict?: (planId: string, caseId: string, verdict: 'pass' | 'fail', note?: string) => Promise<void>
  onOpenBench?: () => void
  compact?: boolean
}) {
  // only verdicts on the current version count; older ones are shown as stale
  const fresh = verdicts.filter((v) => (v.seq ?? 0) > latestCommitSeq)
  const stale = verdicts.filter((v) => (v.seq ?? 0) <= latestCommitSeq)
  const byCase = latestVerdicts(fresh)
  const staleByCase = latestVerdicts(stale)
  const states = plan.payload.cases.map((c) => caseState(byCase.get(c.id)))
  const verified = states.filter((s) => s !== 'untested').length
  const failing = states.filter((s) => s === 'fail').length
  return (
    <div className={cn('max-w-[70ch] border border-hairline-strong bg-surface', compact && 'max-w-none border-x-0 border-b-0')}>
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="telemetry text-primary">Tests</span>
        <span className="tnum telemetry text-secondary">
          {verified}/{plan.payload.cases.length} tried
        </span>
        {failing > 0 && <span className="tnum telemetry bg-signal-500 px-1.5 font-bold text-on-accent">{failing} failing</span>}
        {onOpenBench && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={onOpenBench}>
            Co-test in the bench
          </Button>
        )}
      </div>
      <ol className="divide-y divide-hairline">
        {plan.payload.cases.map((c, i) => (
          <CaseRow key={c.id} index={i} c={c} state={states[i]!} verdicts={byCase.get(c.id) ?? []} staleVerdicts={staleByCase.get(c.id) ?? []} onVerdict={onVerdict ? (v, note) => onVerdict(plan.payload.planId, c.id, v, note) : undefined} />
        ))}
      </ol>
    </div>
  )
}

function CaseRow({
  index,
  c,
  state,
  verdicts,
  staleVerdicts,
  onVerdict,
}: {
  index: number
  c: Plan['payload']['cases'][number]
  state: CaseState
  verdicts: Verdict[]
  staleVerdicts: Verdict[]
  onVerdict?: (verdict: 'pass' | 'fail', note?: string) => Promise<void>
}) {
  const [failing, setFailing] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const noteId = useId()
  const send = async (v: 'pass' | 'fail', n?: string) => {
    if (!onVerdict) return
    setBusy(true)
    try {
      await onVerdict(v, n)
      setFailing(false)
      setNote('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="px-3 py-2">
      <div className="flex gap-2.5">
        <span aria-hidden className={cn('w-3 shrink-0 text-center font-mono font-bold', MARK[state].cls)}>
          {MARK[state].glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-small text-primary">
            <span className="tnum telemetry mr-1.5 text-tertiary">{String(index + 1).padStart(2, '0')}</span>
            {c.action}
            <span className="sr-only"> — {MARK[state].sr}</span>
          </div>
          <div className="mt-0.5 text-small text-secondary">
            <span className="telemetry mr-1 text-tertiary">Expect</span>
            {c.expect}
          </div>
          {verdicts.length === 0 && staleVerdicts.length > 0 && (
            <div className="mt-1 text-small text-tertiary">
              <span className="telemetry mr-1 border border-dashed border-hairline-strong px-1">Stale</span>
              {staleVerdicts.map((v) => v.payload.byName).join(', ')} tried an earlier version — the code changed since. Re-check it.
            </div>
          )}
          {verdicts.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {verdicts.map((v) => (
                <li key={v.id} className={cn('text-small', v.payload.verdict === 'fail' ? 'text-danger' : 'text-ok')}>
                  <span className="font-semibold">{v.payload.byName}</span> {v.payload.verdict === 'fail' ? 'saw it fail' : 'saw it pass'}
                  {v.payload.note ? <span className="text-secondary">: {v.payload.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        {onVerdict && !failing && (
          <div className="flex shrink-0 items-start gap-1" role="group" aria-label={`Your verdict on test ${index + 1}`}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send('pass')} aria-label={`Passes: ${c.action}`}>
              Pass
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setFailing(true)} aria-label={`Fails: ${c.action}`}>
              Fail
            </Button>
          </div>
        )}
      </div>
      {failing && (
        <form
          className="ml-5 mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void send('fail', note.trim() || undefined)
          }}
        >
          <label htmlFor={noteId} className="sr-only">
            What happened instead?
          </label>
          <input
            id={noteId}
            name="verdict-note"
            autoComplete="off"
            autoFocus
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened instead…"
            className="loom-input py-1 text-small"
          />
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            Mark failing
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFailing(false)}>
            Cancel
          </Button>
        </form>
      )}
    </li>
  )
}
