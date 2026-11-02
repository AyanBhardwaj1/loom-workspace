import { structuredPatch } from 'diff'
import { diff3Merge } from 'node-diff3'

/**
 * The coordination engine: which parts of a file a change touches (by symbol —
 * function, method, CSS rule, HTML section), and whether two changes to the
 * same files would merge. Pure functions over file contents, so the same code
 * runs against a git checkout, the serverless DB repo, or a laptop agent's
 * announced work.
 */

export interface SymbolRange {
  name: string
  /** 1-based, inclusive */
  start: number
  end: number
}

export type Tree = Map<string, string>

const JS_EXT = /\.(m?[jt]sx?|cjs)$/i
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'with', 'do', 'try', 'new', 'typeof', 'await'])

/** Heuristic symbol outline: good enough to say "both agents changed submitForm()". */
export function symbolsOf(filePath: string, content: string): SymbolRange[] {
  const lines = content.split('\n')
  const starts: Array<{ name: string; line: number }> = []
  const push = (name: string, line: number) => starts.push({ name, line })
  if (JS_EXT.test(filePath)) {
    lines.forEach((l, i) => {
      let m =
        /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(l) ??
        /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.exec(l) ??
        /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l)
      if (m) return push(m[1]!, i + 1)
      m = /^\s+(?:static\s+|async\s+|get\s+|set\s+|public\s+|private\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/.exec(l)
      if (m && !KEYWORDS.has(m[1]!)) push(`${m[1]}()`, i + 1)
    })
  } else if (/\.(s?css|less)$/i.test(filePath)) {
    lines.forEach((l, i) => {
      const m = /^\s*([^{}@/][^{}]*?)\s*\{\s*$/.exec(l) ?? /^\s*(@media[^{]*)\{\s*$/.exec(l)
      if (m) push(m[1]!.trim().replace(/\s+/g, ' ').slice(0, 60), i + 1)
    })
  } else if (/\.html?$/i.test(filePath)) {
    lines.forEach((l, i) => {
      const m = /<(section|header|footer|nav|main|form|aside|article|dialog|script|style)\b([^>]*)>/i.exec(l)
      if (!m) return
      const id = /\bid=["']([^"']+)["']/.exec(m[2] ?? '')?.[1]
      const cls = /\bclass=["']([^"']+)["']/.exec(m[2] ?? '')?.[1]?.split(/\s+/)[0]
      push(id ? `#${id}` : cls ? `${m[1]!.toLowerCase()}.${cls}` : `<${m[1]!.toLowerCase()}>`, i + 1)
    })
  } else if (/\.py$/i.test(filePath)) {
    lines.forEach((l, i) => {
      const m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(l) ?? /^\s*class\s+([A-Za-z_]\w*)/.exec(l)
      if (m) push(m[1]!, i + 1)
    })
  }
  return starts.map((s, i) => ({ name: s.name, start: s.line, end: (starts[i + 1]?.line ?? lines.length + 1) - 1 }))
}

function symbolsAt(symbols: SymbolRange[], lines: Iterable<number>): string[] {
  const hit = new Set<string>()
  for (const ln of lines) {
    const s = symbols.find((x) => ln >= x.start && ln <= x.end)
    if (s) hit.add(s.name)
  }
  return [...hit]
}

/** the symbols one file's change touches (old-side for edits/deletions, new-side for additions) */
export function changedSymbols(filePath: string, before: string | undefined, after: string | undefined): string[] {
  if (before === after) return []
  if (before === undefined || after === undefined) return [] // whole-file create/delete: the file is the unit
  const patch = structuredPatch('a', 'b', before, after, '', '', { context: 0 })
  const oldLines = new Set<number>()
  const newLines = new Set<number>()
  for (const h of patch.hunks) {
    let o = h.oldStart
    let n = h.newStart
    for (const l of h.lines) {
      if (l.startsWith('-')) oldLines.add(o++)
      else if (l.startsWith('+')) newLines.add(n++)
      else {
        o++
        n++
      }
    }
    // a pure insertion touches the symbol it lands in
    if (h.oldLines === 0) oldLines.add(Math.max(1, h.oldStart))
  }
  return [...new Set([...symbolsAt(symbolsOf(filePath, before), oldLines), ...symbolsAt(symbolsOf(filePath, after), newLines)])]
}

export interface FileChange {
  path: string
  kind: 'create' | 'edit' | 'delete'
  symbols: string[]
}

/** everything a branch changed relative to its base, file by file */
export function changesBetween(base: Tree, next: Tree): FileChange[] {
  const out: FileChange[] = []
  for (const p of new Set([...base.keys(), ...next.keys()])) {
    const a = base.get(p)
    const b = next.get(p)
    if (a === b) continue
    out.push({ path: p, kind: a === undefined ? 'create' : b === undefined ? 'delete' : 'edit', symbols: changedSymbols(p, a, b) })
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

export interface MergeConflict {
  path: string
  /** symbols in the base where both sides changed the same lines ([] = whole-file conflict) */
  symbols: string[]
}

export interface TestMerge {
  clean: boolean
  conflicts: MergeConflict[]
  /** the merged tree (conflicting files keep "ours") */
  merged: Tree
}

const isBinary = (s: string) => s.startsWith('\u0000')

/**
 * Three-way test merge of two trees over their common base — nothing is
 * written anywhere. Conflicts name the base symbols both sides changed.
 */
export function testMerge(base: Tree, ours: Tree, theirs: Tree): TestMerge {
  const merged: Tree = new Map()
  const conflicts: MergeConflict[] = []
  for (const p of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const b = base.get(p)
    const o = ours.get(p)
    const t = theirs.get(p)
    if (o === t) {
      if (o !== undefined) merged.set(p, o)
    } else if (o === b) {
      if (t !== undefined) merged.set(p, t)
    } else if (t === b) {
      if (o !== undefined) merged.set(p, o)
    } else if (o === undefined || t === undefined || isBinary(o) || isBinary(t) || (b !== undefined && isBinary(b))) {
      conflicts.push({ path: p, symbols: [] })
      if (o !== undefined) merged.set(p, o)
    } else {
      const blocks = diff3Merge(o.split('\n'), (b ?? '').split('\n'), t.split('\n'))
      const hit = blocks.filter((x) => x.conflict)
      if (hit.length === 0) {
        merged.set(p, blocks.flatMap((x) => x.ok ?? []).join('\n'))
      } else {
        const lines = new Set<number>()
        // an insertion at the end of the file belongs to the last symbol, not to "past the end"
        const last = Math.max(1, (b ?? '').split('\n').length - 1)
        for (const c of hit) {
          const start = (c.conflict!.oIndex ?? 0) + 1
          const len = Math.max(1, c.conflict!.o.length)
          for (let i = 0; i < len; i++) lines.add(Math.min(start + i, last))
        }
        conflicts.push({ path: p, symbols: b ? symbolsAt(symbolsOf(p, b), lines) : [] })
        merged.set(p, o)
      }
    }
  }
  return { clean: conflicts.length === 0, conflicts: conflicts.sort((x, y) => x.path.localeCompare(y.path)), merged }
}

/** human label: "index.html › #hero, .cta" */
export function describe(path: string, symbols: string[]): string {
  return symbols.length > 0 ? `${path} › ${symbols.slice(0, 3).join(', ')}${symbols.length > 3 ? ` +${symbols.length - 3}` : ''}` : path
}
