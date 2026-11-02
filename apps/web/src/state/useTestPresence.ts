import { useEffect, useMemo, useRef, useState } from 'react'
import type { ServerMessage } from '@loom/shared'
import { wsClient } from '../lib/ws'

type Frame = Extract<ServerMessage, { t: 'preview_presence' }>

export interface Tester {
  userId: string
  name: string
  color: string
  /** pointer, document coordinates; null once they leave the frame */
  x: number | null
  y: number | null
  scrollX: number
  scrollY: number
  vw: number
  vh: number
  path: string
  at: number
}

export interface TestAction {
  id: string
  userId: string
  name: string
  color: string
  kind: 'click' | 'nav' | 'error'
  path: string
  label?: string
  message?: string
  x?: number
  y?: number
  at: number
}

/** a tester who has sent nothing for this long has stopped testing */
const STALE_MS = 12_000
const MAX_ACTIONS = 40

/**
 * Who is testing a session's live preview right now and what they're doing.
 * Fed by `preview_presence` frames (identity stamped by the server). Pure
 * client state: nothing here is persisted — it is awareness, not history.
 */
export function useTestPresence(sessionId: string | null, selfId: string | undefined) {
  const [testers, setTesters] = useState<Map<string, Tester>>(new Map())
  const [actions, setActions] = useState<TestAction[]>([])
  const seq = useRef(0)

  useEffect(() => {
    setTesters(new Map())
    setActions([])
    if (!sessionId) return
    const unsub = wsClient.subSession(sessionId)
    const off = wsClient.onMessage((msg) => {
      if (msg.t !== 'preview_presence' || msg.sessionId !== sessionId || msg.userId === selfId) return
      apply(msg)
    })
    const apply = (f: Frame) => {
      const now = Date.now()
      setTesters((prev) => {
        const next = new Map(prev)
        const t: Tester = next.get(f.userId) ?? {
          userId: f.userId, name: f.name, color: f.color, x: null, y: null, scrollX: 0, scrollY: 0, vw: 0, vh: 0, path: '/', at: now,
        }
        const u: Tester = { ...t, name: f.name, color: f.color, at: now, path: f.path ?? t.path }
        if (f.kind === 'move' || f.kind === 'click') {
          u.x = f.x ?? u.x
          u.y = f.y ?? u.y
        } else if (f.kind === 'scroll') {
          u.scrollX = f.x ?? 0
          u.scrollY = f.y ?? 0
          u.vw = f.vw ?? u.vw
          u.vh = f.vh ?? u.vh
        } else if (f.kind === 'leave') {
          u.x = null
          u.y = null
        } else if (f.kind === 'nav') {
          u.x = null
          u.y = null
          u.scrollX = 0
          u.scrollY = 0
        }
        next.set(f.userId, u)
        return next
      })
      if (f.kind === 'click' || f.kind === 'error' || f.kind === 'nav') {
        const id = `${f.userId}-${++seq.current}`
        setActions((prev) => {
          // nav repeats on every reload — only record real page changes
          if (f.kind === 'nav') {
            const last = prev.find((a) => a.userId === f.userId && a.kind === 'nav')
            if (last && last.path === f.path) return prev
          }
          return [{ id, userId: f.userId, name: f.name, color: f.color, kind: f.kind as TestAction['kind'], path: f.path ?? '/', label: f.label, message: f.message, x: f.x, y: f.y, at: now }, ...prev].slice(0, MAX_ACTIONS)
        })
      }
    }
    const sweep = setInterval(() => {
      const cutoff = Date.now() - STALE_MS
      setTesters((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [id, t] of next) {
          if (t.at < cutoff) {
            next.delete(id)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 2000)
    return () => {
      off()
      unsub()
      clearInterval(sweep)
    }
  }, [sessionId, selfId])

  const list = useMemo(() => [...testers.values()].sort((a, b) => a.name.localeCompare(b.name)), [testers])
  return { testers: list, actions }
}

/** shorten `/preview/session/:id/about.html` to `/about.html` for display */
export function displayPath(path: string): string {
  const m = /^\/preview\/(?:session\/[^/]+|main\/[^/]+)(\/.*)?$/.exec(path)
  return m ? m[1] || '/' : path
}
