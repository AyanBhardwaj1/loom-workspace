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
