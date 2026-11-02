import type { SessionEvent, SessionEventOf } from './events'

/**
 * "Nothing reaches main that the room hasn't seen work."
 *
 * The verified-to-merge gate, as a pure function of a session's event log, so
 * the server enforces exactly what every viewer is shown. Separation of duties
 * borrows the one strong precedent in the market (the requester of an agent PR
 * can't approve it): the person who drove the agent can't be the one who
 * verifies or merges its work. On a one-person project there is no second
 * person, so those rules step aside rather than blocking forever.
 */

export type GateMode = 'enforce' | 'warn' | 'off'

export interface ProjectPolicy {
  /** the verified-to-merge gate */
  mergeGate: GateMode
  /** destructive agent actions need a second member's approval */
  guardedActions: boolean
  /** while frozen, the agent may not write anything (enforced server-side, not by prompt) */
  frozen: boolean
  frozenBy: string | null
  /** writes to these paths (globs: `*` within a segment, `**` across) need approval */
  protectedPaths: string[]
}

/**
 * Projects created before the gate existed (and the seeded demo) default to
 * 'warn' — they keep merging, and history records unverified merges. New
 * projects are created with 'enforce' (see ProjectService.createProject).
 */
export const DEFAULT_POLICY: ProjectPolicy = {
  mergeGate: 'warn',
  guardedActions: true,
  frozen: false,
  frozenBy: null,
  protectedPaths: ['.env', '.env.*', '**/*.sql', 'migrations/**'],
}

export interface GateCheck {
  id: 'checks' | 'verified' | 'separation'
  label: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
}

export interface MergeGate {
  mode: GateMode
  /** may merge without an override */
  ok: boolean
  checks: GateCheck[]
  /** names of non-driver members whose fresh pass verdicts verify this version */
  verifiedBy: string[]
}

/** tools that change the workspace — a check run before them no longer describes the code */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'run_command'])

/** the seq of the latest commit — verdicts and checks older than it describe code that has moved */
export function latestCommitSeq(events: SessionEvent[]): number {
  let seq = 0
  for (const e of events) if (e.type === 'commit' && (e.seq ?? 0) > seq) seq = e.seq ?? 0
  return seq
}

/** a verdict is fresh when it was given after the latest commit */
export function isFreshVerdict(v: SessionEventOf<'test_verdict'>, commitSeq: number): boolean {
  return (v.seq ?? 0) > commitSeq
}

export function evaluateMergeGate(input: {
  events: SessionEvent[]
  driverUserId: string
  mergerUserId: string
  memberCount: number
  mode: GateMode
}): MergeGate {
  const { events, driverUserId, mergerUserId, memberCount, mode } = input
  const solo = memberCount <= 1
  const commitSeq = latestCommitSeq(events)
  const checks: GateCheck[] = []

  // 1 — the shared smoke test ran on THIS version and didn't fail. The agent
  // checks its working tree just before the turn's commit, so a run in the same
  // turn counts when no file-writing tool ran between it and the commit.
  let lastRun: SessionEventOf<'check_run'> | null = null
  for (const e of events) if (e.type === 'check_run' && (e.seq ?? 0) > commitSeq) lastRun = e
  if (!lastRun && commitSeq > 0) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if ((e.seq ?? 0) >= commitSeq) continue
      if (e.type === 'user_message' || (e.type === 'tool_call' && WRITE_TOOLS.has(e.payload.toolName))) break
      if (e.type === 'check_run') {
        lastRun = e
        break
      }
    }
  }
  checks.push(
    lastRun === null
      ? { id: 'checks', label: 'Checks pass on the latest version', status: 'fail', detail: 'No check run since the latest change — run checks.' }
      : lastRun.payload.status === 'failed'
        ? {
            id: 'checks',
            label: 'Checks pass on the latest version',
            status: 'fail',
            detail: `Failing: ${lastRun.payload.results.filter((r) => r.status === 'fail').map((r) => r.label).join(', ')}`,
          }
        : { id: 'checks', label: 'Checks pass on the latest version', status: 'pass', detail: `${lastRun.payload.status} · run by ${lastRun.payload.byName}` },
  )

  // 2 — a teammate tried the agent's test cases on this version, and none fail
  let plan: SessionEventOf<'test_plan'> | null = null
  for (const e of events) if (e.type === 'test_plan') plan = e
  const verifiedBy = new Set<string>()
  if (!plan) {
    checks.push({ id: 'verified', label: 'Verified by a teammate', status: 'skip', detail: 'The agent proposed no test cases for this work.' })
  } else {
    const fresh = events.filter(
      (e): e is SessionEventOf<'test_verdict'> => e.type === 'test_verdict' && e.payload.planId === plan!.payload.planId && isFreshVerdict(e, commitSeq),
    )
    // each person's latest fresh verdict per case
    const latest = new Map<string, SessionEventOf<'test_verdict'>>()
    for (const v of fresh) latest.set(`${v.payload.caseId}::${v.payload.byUserId}`, v)
    const failing = plan.payload.cases.filter((c) => [...latest.values()].some((v) => v.payload.caseId === c.id && v.payload.verdict === 'fail'))
    const untried = plan.payload.cases.filter((c) => ![...latest.values()].some((v) => v.payload.caseId === c.id && v.payload.verdict === 'pass'))
    for (const v of latest.values()) if (v.payload.verdict === 'pass' && (solo || v.payload.byUserId !== driverUserId)) verifiedBy.add(v.payload.byName)
    const byOthers = solo || [...latest.values()].some((v) => v.payload.byUserId !== driverUserId && v.payload.verdict === 'pass')
    checks.push(
      failing.length > 0
        ? { id: 'verified', label: 'Verified by a teammate', status: 'fail', detail: `${failing.length} test case${failing.length === 1 ? '' : 's'} failing on this version.` }
        : untried.length > 0
          ? { id: 'verified', label: 'Verified by a teammate', status: 'fail', detail: `${untried.length} of ${plan.payload.cases.length} test cases not yet passed on this version.` }
          : !byOthers
            ? { id: 'verified', label: 'Verified by a teammate', status: 'fail', detail: 'Only the driver has tried it — someone else needs to.' }
            : { id: 'verified', label: 'Verified by a teammate', status: 'pass', detail: `Passed by ${[...verifiedBy].join(', ') || 'the team'}.` },
    )
  }

  // 3 — the person who drove the agent doesn't merge its work
  checks.push(
    solo
      ? { id: 'separation', label: 'Merged by someone other than the driver', status: 'skip', detail: 'One-person project — no second person to ask.' }
      : mergerUserId === driverUserId
        ? { id: 'separation', label: 'Merged by someone other than the driver', status: 'fail', detail: 'You drove this session — a teammate merges it.' }
        : { id: 'separation', label: 'Merged by someone other than the driver', status: 'pass', detail: 'A second person is merging.' },
  )

  const ok = mode !== 'enforce' || checks.every((c) => c.status !== 'fail')
  return { mode, ok, checks, verifiedBy: [...verifiedBy] }
}

/** glob match for protected paths: `*` within one segment, `**` across segments */
export function matchesProtected(filePath: string, patterns: string[]): boolean {
  const p = filePath.replace(/^\.?\//, '')
  return patterns.some((pat) => {
    const re = new RegExp(
      '^' +
        pat
          .replace(/^\.?\//, '')
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\/?/g, '\u0000')
          .replace(/\*/g, '[^/]*')
          .replace(/\u0000/g, '(?:.*/)?') +
        '$',
    )
    return re.test(p) || re.test(p.split('/').pop() ?? p)
  })
}
