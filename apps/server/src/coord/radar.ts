import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, gt } from 'drizzle-orm'
import type { DbHandle } from '../db/client'
import type { ServerConfig } from '../env'
import type { Repo } from '../git/repo'
import type { ProjectService } from '../projects/service'
import type { SessionService } from '../sessions/service'
import { changesBetween, describe, testMerge, type FileChange, type MergeConflict, type Tree } from './engine'

/**
 * The radar: for every live piece of work in a project — each active
 * session's branch, plus work laptop agents announce over MCP — what it
 * changes (files and symbols), where two pieces of work touch the same
 * files, and whether they would merge (a test-merge; nothing is written).
 *
 * Uncommitted work counts: on a persistent disk the session's checkout is
 * read as-is, so an agent's edits are visible to the radar mid-turn — before
 * anything is committed, which is when a conflict is cheapest to fix.
 */

export interface WorkItem {
  key: string
  kind: 'session' | 'external'
  sessionId: string | null
  title: string
  branchName: string
  userId: string
  userName: string
  userColor: string
  moduleName: string | null
  /** an agent turn is running on it right now */
  working: boolean
  changes: FileChange[]
  createdAt: string
  /** when this work first landed (its first commit; announce time for laptop agents) — live main's order */
  firstWorkAt: string
}

export interface Overlap {
  a: string
  b: string
  /** files both changed */
  files: string[]
  /** a test-merge found real conflicts (null = unknown: external work announces names, not contents) */
  conflicts: MergeConflict[] | null
}

export interface MainStatus {
  ahead: number
  behind: number
  status: 'up-to-date' | 'ready' | 'behind' | 'conflicts'
  conflicts: MergeConflict[]
}

export interface RadarSnapshot {
  radar: Radar
  /** per session work item: its tree (uncommitted edits where visible) and its base on main */
  work: Map<string, { tree: Tree; base: Tree; baseSha: string | null; branch: string }>
  mainTree: Tree
  mainSha: string
}

export interface Radar {
  projectId: string
  computedAt: string
  items: WorkItem[]
  overlaps: Overlap[]
  vsMain: Record<string, MainStatus>
}

const TREE_CACHE_MAX = 300
const RADAR_TTL_MS = 2500
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'dist'])

export class RadarService {
  private trees = new Map<string, Tree>()
  private memo = new Map<string, { at: number; snap: Promise<RadarSnapshot> }>()

  constructor(
    private deps: {
      dbh: DbHandle
      config: ServerConfig
      projects: ProjectService
      sessions: SessionService
      isWorking: (sessionId: string) => Promise<boolean>
      /** a turn for this session runs on THIS instance (its checkout here is the live one) */
      isLocalTurn?: (sessionId: string) => boolean
    },
  ) {}

  /** trees are immutable per commit — cache them by repo + sha */
  private async tree(repo: Repo, sha: string): Promise<Tree> {
    const key = `${repo.repoPath}@${sha}`
    const hit = this.trees.get(key)
    if (hit) return hit
    const t = await repo.readTree(sha)
    if (this.trees.size >= TREE_CACHE_MAX) this.trees.delete(this.trees.keys().next().value!)
    this.trees.set(key, t)
    return t
  }

  /**
   * The checkout on disk, uncommitted edits included — on a persistent disk
   * always; on serverless only where this instance is running that session's
   * turn (elsewhere the committed state is the truth).
   */
  private working(dir: string, sessionId: string): Tree | null {
    const live = this.deps.config.platform === 'server' || this.deps.isLocalTurn?.(sessionId) === true
    if (!live || !fs.existsSync(dir)) return null
    const out: Tree = new Map()
    const walk = (abs: string, rel: string) => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue
        const a = path.join(abs, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(a, r)
        else if (e.isFile()) {
          const buf = fs.readFileSync(a)
          if (buf.length > 2 * 1024 * 1024) continue
          out.set(r, buf.subarray(0, 8000).includes(0) ? `\u0000bin:${crypto.createHash('sha1').update(buf).digest('hex')}` : buf.toString('utf8'))
        }
      }
    }
    walk(dir, '')
    return out
  }

  /** compute (or reuse a radar a couple of seconds old) */
  async forProject(projectId: string, opts: { fresh?: boolean } = {}): Promise<Radar> {
    return (await this.snapshot(projectId, opts)).radar
  }

  /** something moved (an announcement, a merge): the next read recomputes */
  invalidate(projectId: string): void {
    this.memo.delete(projectId)
  }

  /** the radar plus the trees behind it (live main builds on these) */
  async snapshot(projectId: string, opts: { fresh?: boolean } = {}): Promise<RadarSnapshot> {
    const hit = this.memo.get(projectId)
    if (hit && !opts.fresh && Date.now() - hit.at < RADAR_TTL_MS) return hit.snap
    const snap = this.compute(projectId)
    this.memo.set(projectId, { at: Date.now(), snap })
    snap.catch(() => this.memo.delete(projectId))
    return snap
  }

  private async compute(projectId: string): Promise<RadarSnapshot> {
    const { projects, sessions, dbh } = this.deps
    const project = await projects.getProject(projectId)
    if (!project) throw new Error('Project not found')
    const repo = projects.gitFor(project)
    const mainSha = await repo.currentSha('main')
    const mainTree = await this.tree(repo, mainSha)
    const active = await sessions.listActiveSessionsForProject(projectId)
    const modules = new Map((await projects.listModules(projectId)).map((m) => [m.id, m.name]))
    const users = new Map((await projects.getMembers(projectId)).map((u) => [u.id, u]))

    const items: WorkItem[] = []
    const work = new Map<string, { tree: Tree; base: Tree; baseSha: string | null; branch: string }>()
    const vsMain: Record<string, MainStatus> = {}

    for (const s of active) {
      let head: string
      try {
        head = await repo.currentSha(s.branchName)
      } catch {
        continue
      }
      const baseSha = await repo.mergeBase(s.branchName, 'main')
      const base = baseSha ? await this.tree(repo, baseSha) : new Map()
      const tree = this.working(s.worktreePath, s.id) ?? (await this.tree(repo, head))
      const changes = changesBetween(base, tree)
      const u = users.get(s.driverUserId)
      const key = `session:${s.id}`
      const firstCommit = (await sessions.getEvents(s.id, 0)).find((e) => e.type === 'commit')
      items.push({
        key,
        kind: 'session',
        sessionId: s.id,
        title: s.title,
        branchName: s.branchName,
        userId: s.driverUserId,
        userName: u?.name ?? 'Former member',
        userColor: u?.avatarColor ?? '#C9C3B5',
        moduleName: modules.get(s.moduleId) ?? null,
        working: await this.deps.isWorking(s.id),
        changes,
        createdAt: s.createdAt,
        firstWorkAt: firstCommit?.createdAt ?? '\uffff' + s.createdAt,
      })
      work.set(key, { tree, base, baseSha, branch: s.branchName })
      const { ahead, behind } = await repo.aheadBehind(s.branchName).catch(() => ({ ahead: 0, behind: 0 }))
      const intoMain = changes.length > 0 ? testMerge(base, mainTree, tree) : null
      vsMain[key] = {
        ahead,
        behind,
        conflicts: intoMain?.conflicts ?? [],
        status: intoMain && !intoMain.clean ? 'conflicts' : changes.length === 0 && ahead === 0 ? 'up-to-date' : behind > 0 && changes.length === 0 ? 'behind' : 'ready',
      }
    }

    // laptop agents' announced work (paths + symbol names; no contents)
    const { db, t } = dbh
    const ext = await db
      .select()
      .from(t.externalWork)
      .where(and(eq(t.externalWork.projectId, projectId), gt(t.externalWork.expiresAt, new Date().toISOString())))
    for (const x of ext) {
      const u = users.get(x.userId)
      if (!u) continue
      const files = JSON.parse(x.files) as Array<{ path: string; symbols?: string[] }>
      items.push({
        key: `external:${x.id}`,
        kind: 'external',
        sessionId: null,
        title: x.summary || `${u.name}'s ${x.agent}`,
        branchName: x.branch,
        userId: u.id,
        userName: u.name,
        userColor: u.avatarColor,
        moduleName: null,
        working: true,
        changes: files.map((f) => ({ path: f.path, kind: 'edit', symbols: f.symbols ?? [] })),
        createdAt: x.updatedAt,
        firstWorkAt: x.updatedAt,
      })
    }

    // every pair of work items that touch the same files
    const overlaps: Overlap[] = []
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const A = items[i]!
        const B = items[j]!
        const shared = A.changes.map((c) => c.path).filter((p) => B.changes.some((c) => c.path === p))
        if (shared.length === 0) continue
        let conflicts: MergeConflict[] | null = null
        const wa = work.get(A.key)
        const wb = work.get(B.key)
        if (wa && wb) {
          const common = await repo.mergeBase(wa.branch, wb.branch)
          const baseTree = common ? await this.tree(repo, common) : wa.base
          conflicts = testMerge(baseTree, wa.tree, wb.tree).conflicts
        } else {
          // announced work: a likely conflict when both name the same symbol (or a whole file)
          conflicts = []
          for (const p of shared) {
            const sa = A.changes.find((c) => c.path === p)!.symbols
            const sb = B.changes.find((c) => c.path === p)!.symbols
            const both = sa.filter((s) => sb.includes(s))
            if (both.length > 0 || sa.length === 0 || sb.length === 0) conflicts.push({ path: p, symbols: both })
          }
        }
        overlaps.push({ a: A.key, b: B.key, files: shared, conflicts })
      }
    }
    return { radar: { projectId, computedAt: new Date().toISOString(), items, overlaps, vsMain }, work, mainTree, mainSha }
  }

  /** what one agent should hear: who else is in its files, and any conflicts */
  briefingFor(radar: Radar, key: string): { text: string | null; conflicts: Array<{ other: WorkItem | null; against: 'session' | 'main' | 'external'; items: MergeConflict[] }> } {
    const me = radar.items.find((i) => i.key === key)
    if (!me) return { text: null, conflicts: [] }
    const lines: string[] = []
    const conflicts: Array<{ other: WorkItem | null; against: 'session' | 'main' | 'external'; items: MergeConflict[] }> = []
    const others = radar.items.filter((i) => i.key !== key && i.changes.length > 0)
    for (const o of others) {
      const ov = radar.overlaps.find((x) => (x.a === key && x.b === o.key) || (x.b === key && x.a === o.key))
      const where = o.kind === 'external' ? 'on their computer' : `in Loom session "${o.title}"`
      const files = o.changes.slice(0, 4).map((c) => describe(c.path, c.symbols)).join('; ')
      if (!ov) {
        if (lines.length < 6) lines.push(`- ${o.userName}'s agent (${where}, branch ${o.branchName}): ${files}`)
        continue
      }
      lines.push(`- ${o.userName}'s agent (${where}, branch ${o.branchName}) is ALSO changing ${ov.files.join(', ')}: ${files}`)
      if (ov.conflicts && ov.conflicts.length > 0) conflicts.push({ other: o, against: o.kind === 'external' ? 'external' : 'session', items: ov.conflicts })
    }
    const main = radar.vsMain[key]
    if (main?.status === 'conflicts') conflicts.push({ other: null, against: 'main', items: main.conflicts })
    if (lines.length === 0 && conflicts.length === 0) return { text: null, conflicts }
    const parts = ['Teammates’ agents working on this project right now (from the coordination radar):', ...lines]
    if (conflicts.length > 0) {
      parts.push('Conflicts the radar found (a test-merge, nothing changed yet):')
      for (const c of conflicts) {
        parts.push(`- with ${c.other ? `${c.other.userName}'s work` : 'what is already merged into main'}: ${c.items.map((i) => describe(i.path, i.symbols)).join('; ')}`)
      }
      parts.push('Adapt your change now while it is small: keep both intents, prefer touching different functions/rules, and say what you changed to fit. Never undo their work.')
    } else {
      parts.push('Stay clear of the functions they are changing where you can; if you must touch them, keep both intents.')
    }
    return { text: parts.join('\n'), conflicts }
  }
}

/** stable signature for a reported conflict (so it is told once, and resolution can be matched) */
export function conflictKey(a: string, b: string, items: MergeConflict[]): string {
  const pair = [a, b].sort().join('|')
  const what = items
    .map((i) => `${i.path}:${[...i.symbols].sort().join(',')}`)
    .sort()
    .join(';')
  return crypto.createHash('sha1').update(`${pair}#${what}`).digest('hex').slice(0, 16)
}
