import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Modal } from './overlay'

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

/**
 * F6 — global keys + the `?` cheat sheet. Lists ONLY shortcuts that exist;
 * every one is also reachable by click.
 */
export function Shortcuts() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  const projectId = useMemo(() => /^\/p\/([^/]+)/.exec(location.pathname)?.[1] ?? null, [location.pathname])
  const sessionId = useMemo(() => /\/s\/([^/]+)/.exec(location.pathname)?.[1] ?? null, [location.pathname])
  const inReplay = location.pathname.startsWith('/replay/')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inEditable(e.target)) return
      if (e.key === '?') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'h' && projectId) {
        e.preventDefault()
        navigate(`/p/${projectId}/history`)
      } else if (e.key === 'r' && sessionId) {
        e.preventDefault()
        navigate(`/replay/${sessionId}`)
      } else if ((e.key === '[' || e.key === ']') && sessionId) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('loom:sidebar', { detail: e.key === ']' }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, projectId, sessionId])

  const rows: Array<[string[], string]> = [
    [['⌘', 'K'], 'Command palette'],
    ...(projectId ? ([[['h'], 'Version history']] as Array<[string[], string]>) : []),
    ...(sessionId ? ([[['r'], 'Replay this session']] as Array<[string[], string]>) : []),
    ...(sessionId ? ([[['['], 'Hide spectate panel'], [[']'], 'Show spectate panel']] as Array<[string[], string]>) : []),
    ...(inReplay
      ? ([[['←', '→'], 'Step events'], [['space'], 'Play / pause']] as Array<[string[], string]>)
      : []),
    [['?'], 'This sheet'],
    [['esc'], 'Close dialogs'],
  ]

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" width={420}>
      <div className="space-y-1">
        {rows.map(([keys, label], i) => (
          <div key={i} className="flex h-8 items-center gap-3">
            <span className="flex w-24 shrink-0 items-center gap-1">
              {keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
            <span className="text-ui text-secondary">{label}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
