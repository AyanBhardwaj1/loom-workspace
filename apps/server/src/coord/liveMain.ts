import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CheckRun } from '../checks/runChecks'
import { runChecks } from '../checks/runChecks'
import type { ServerConfig } from '../env'
import { testMerge, type MergeConflict, type Tree } from './engine'
import type { RadarService } from './radar'

/**
 * Live main: everyone's work in progress, combined, runnable, read-only.
 * Start from main and fold in each active session's work in arrival order
 * with a real three-way merge. Work that collides with something already
 * folded in "doesn't fit yet" — it names whose work and which function — and
 * the newer work adapts. The combined tree is written to a scratch checkout,
 * checked, and previewable, so the room can open the product as it will be.
 */

export interface LiveMainEntry {
  key: string
  sessionId: string
  title: string
  userName: string
  userColor: string
  branchName: string
  status: 'in-live-main' | 'doesnt-fit' | 'nothing-yet'
  conflicts: MergeConflict[]
  /** whose already-included work it collides with */
  collidesWith: string[]
}

export interface LiveMain {
  projectId: string
  builtAt: string
  mainSha: string
  fingerprint: string
  entries: LiveMainEntry[]
  checks: Pick<CheckRun, 'status' | 'results'> | null
}

const binaryMarker = (s: string) => s.startsWith('\u0000')

export class LiveMainService {
  private built = new Map<string, Promise<LiveMain>>()

  constructor(private deps: { config: ServerConfig; radar: RadarService }) {}

  dirFor(projectId: string): string {
    return path.join(this.deps.config.dataDir, 'live', projectId)
  }

  /** current live main, rebuilt only when someone's work (or main) moved */
  async get(projectId: string): Promise<LiveMain> {
    const snap = await this.deps.radar.snapshot(projectId)
    const fingerprint = crypto
      .createHash('sha1')
      .update(snap.mainSha)
      .update(
        [...snap.work.entries()]
          .map(([k, w]) => `${k}:${crypto.createHash('sha1').update(JSON.stringify([...w.tree.entries()])).digest('hex')}`)
          .sort()
          .join('|'),
      )
      .digest('hex')
    const prev = this.built.get(projectId)
    if (prev) {
      const p = await prev.catch(() => null)
      if (p && p.fingerprint === fingerprint && fs.existsSync(this.dirFor(projectId))) return p
    }
    const next = this.build(projectId, fingerprint, snap)
    this.built.set(projectId, next)
    next.catch(() => this.built.delete(projectId))
    return next
  }

  private async build(projectId: string, fingerprint: string, snap: Awaited<ReturnType<RadarService['snapshot']>>): Promise<LiveMain> {
    const { radar, work, mainTree, mainSha } = snap
    let combined: Tree = new Map(mainTree)
    /** path → names of people whose included work changed it */
    const touchedBy = new Map<string, Set<string>>()
    const entries: LiveMainEntry[] = []
    // arrival order: whoever's work landed first is in; later work adapts to it
    const sessions = radar.items.filter((i) => i.kind === 'session').sort((a, b) => a.firstWorkAt.localeCompare(b.firstWorkAt) || a.key.localeCompare(b.key))
    for (const item of sessions) {
      const w = work.get(item.key)
      const base = { key: item.key, sessionId: item.sessionId!, title: item.title, userName: item.userName, userColor: item.userColor, branchName: item.branchName }
      if (!w || item.changes.length === 0) {
        entries.push({ ...base, status: 'nothing-yet', conflicts: [], collidesWith: [] })
        continue
      }
      const r = testMerge(w.base, combined, w.tree)
      if (!r.clean) {
        const who = new Set<string>()
        // blame precisely: whoever's included work changed the conflicting symbol (else the file)
        for (const c of r.conflicts) {
          const bySymbol = c.symbols.flatMap((sym) => [...(touchedBy.get(`${c.path}::${sym}`) ?? [])])
          for (const n of bySymbol.length > 0 ? bySymbol : (touchedBy.get(c.path) ?? [])) who.add(n)
        }
        entries.push({ ...base, status: 'doesnt-fit', conflicts: r.conflicts, collidesWith: [...who] })
        continue
      }
      combined = r.merged
      const mark = (k: string) => {
        const set = touchedBy.get(k) ?? new Set<string>()
        set.add(item.userName)
        touchedBy.set(k, set)
      }
      for (const c of item.changes) {
        mark(c.path)
        for (const sym of c.symbols) mark(`${c.path}::${sym}`)
      }
      entries.push({ ...base, status: 'in-live-main', conflicts: [], collidesWith: [] })
    }

    // write the combined tree to its own scratch checkout (read-only for everyone)
    const dir = this.dirFor(projectId)
    const tmp = `${dir}.building-${process.pid}-${Date.now()}`
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    for (const [p, content] of combined) {
      if (binaryMarker(content)) continue // binary blobs aren't part of the combined preview
      const abs = path.join(tmp, p)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(tmp, dir)

    let checks: LiveMain['checks'] = null
    try {
      const run = await runChecks(dir, { runTests: false })
      checks = { status: run.status, results: run.results }
    } catch {
      checks = null
    }
    return { projectId, builtAt: new Date().toISOString(), mainSha, fingerprint, entries, checks }
  }
}
