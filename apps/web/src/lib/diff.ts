/** Unified-diff parsing for the diff cards — hunks, line numbers, collapse runs. */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface ParsedDiff {
  lines: DiffLine[]
  additions: number
  deletions: number
}

const SKIP = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let additions = 0
  let deletions = 0
  for (const raw of diff.split('\n')) {
    if (SKIP.test(raw)) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      continue
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', oldNo: null, newNo: newNo++, text: raw.slice(1) })
      additions++
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: raw.slice(1) })
      deletions++
    } else if (raw.startsWith(' ') || raw === '') {
      out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) })
    }
    // '\ No newline at end of file' and anything else: dropped
  }
  return { lines: out, additions, deletions }
}

/**
 * Apply a unified diff to a base text — enough fidelity for our own
 * server-generated diffs (ordered hunks, standard headers). Returns null if a
 * hunk doesn't line up, so callers can fall back gracefully.
 */
export function applyUnifiedDiff(base: string, diff: string): string | null {
  const baseLines = base.length === 0 ? [] : base.split('\n')
  const out: string[] = []
  let cursor = 0 // index into baseLines (0-based)
  const lines = diff.split('\n')
  let i = 0
  let sawHunk = false
  while (i < lines.length) {
    const raw = lines[i]!
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(raw)
    if (!hunk) {
      i++
      continue
    }
    sawHunk = true
    // copy unchanged region before the hunk
    const oldStart = Math.max(Number(hunk[1]), 1) - 1
    if (oldStart < cursor) return null
    out.push(...baseLines.slice(cursor, oldStart))
    cursor = oldStart
    i++
    while (i < lines.length && !lines[i]!.startsWith('@@')) {
      const l = lines[i]!
      if (l.startsWith('+')) {
        out.push(l.slice(1))
      } else if (l.startsWith('-')) {
        cursor++
      } else if (l.startsWith(' ') || l === '') {
        out.push(baseLines[cursor] ?? l.slice(1))
        cursor++
      } else if (l.startsWith('\\')) {
        // "\ No newline at end of file"
      } else {
        break
      }
      i++
    }
  }
  if (!sawHunk) return null
  out.push(...baseLines.slice(cursor))
  return out.join('\n')
}

/**
 * F4 — reconstruct each file's successive contents from the session's
 * file_change events (in seq order). Paths with ≥2 states get an evolution.
 */
export function buildEvolutions(
  events: Array<{ type: string; payload?: unknown }>,
): Map<string, string[]> {
  const contents = new Map<string, string>()
  const states = new Map<string, string[]>()
  for (const e of events) {
    if (e.type !== 'file_change') continue
    const p = e.payload as { path: string; changeKind: 'create' | 'edit' | 'delete'; unifiedDiff: string }
    const prev = contents.get(p.path) ?? ''
    let next: string | null
    if (p.changeKind === 'delete') {
      next = ''
    } else {
      next = applyUnifiedDiff(prev, p.unifiedDiff)
      if (next === null && p.changeKind === 'create') {
        // fall back: a create diff is purely additions
        next = p.unifiedDiff
          .split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .map((l) => l.slice(1))
          .join('\n')
      }
    }
    if (next === null) continue // unappliable — stop tracking rather than lie
    contents.set(p.path, next)
    const list = states.get(p.path) ?? ['']
    list.push(next)
    states.set(p.path, list)
  }
  // keep only paths with at least two real states (initial '' + ≥2 changes)
  const out = new Map<string, string[]>()
  for (const [path, list] of states) {
    const real = list.filter((s, idx) => idx > 0 || s !== '')
    if (real.length >= 2) out.set(path, real)
  }
  return out
}

export type DiffGroup =
  | { kind: 'lines'; lines: DiffLine[] }
  | { kind: 'collapsed'; lines: DiffLine[] }

/** Collapse interior runs of unchanged context longer than `keep*2 + 2`. */
export function groupForDisplay(lines: DiffLine[], keep = 3): DiffGroup[] {
  const groups: DiffGroup[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.kind !== 'ctx') {
      const last = groups[groups.length - 1]
      if (last?.kind === 'lines') last.lines.push(line)
      else groups.push({ kind: 'lines', lines: [line] })
      i++
      continue
    }
    // run of context
    let j = i
    while (j < lines.length && lines[j]!.kind === 'ctx') j++
    const run = lines.slice(i, j)
    const isFirst = groups.length === 0 && i === 0
    const isLast = j >= lines.length
    const budget = (isFirst ? 0 : keep) + (isLast ? 0 : keep)
    if (run.length > budget + 2) {
      const head = isFirst ? [] : run.slice(0, keep)
      const tail = isLast ? [] : run.slice(run.length - keep)
      const middle = run.slice(head.length, run.length - tail.length)
      if (head.length) {
        const last = groups[groups.length - 1]
        if (last?.kind === 'lines') last.lines.push(...head)
        else groups.push({ kind: 'lines', lines: [...head] })
      }
      groups.push({ kind: 'collapsed', lines: middle })
      if (tail.length) groups.push({ kind: 'lines', lines: [...tail] })
    } else {
      const last = groups[groups.length - 1]
      if (last?.kind === 'lines') last.lines.push(...run)
      else groups.push({ kind: 'lines', lines: [...run] })
    }
    i = j
  }
  return groups
}
