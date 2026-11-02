import { Bug, ExternalLink, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { identityColor } from '../lib/identity'
import { timeAgo, useNow } from '../lib/time'
import { wsClient, type PreviewPresenceFrame } from '../lib/ws'
import { displayPath, type TestAction, type Tester } from '../state/useTestPresence'
import { Popover, PopoverContent, PopoverTrigger } from './overlay'
import { Button, IconButton, cn } from './primitives'

const KINDS = new Set(['move', 'click', 'scroll', 'nav', 'error', 'leave'])
const TRAIL = 8

/**
 * The test bench: a session's (or merged main's) live product in a sandboxed
 * iframe, plus everyone else who is testing it right now.
 *
 * `sandbox="allow-scripts"` gives the frame an opaque origin — it runs its own
 * JS but cannot reach our DOM, cookies, or (with the server's
 * `connect-src 'none'` CSP) our API. The server injects a small bridge into
 * every page; it postMessages pointer/click/scroll/page/error frames up to us.
 * We accept frames only from our own iframe's window, and relay them over the
 * authenticated socket, where the server stamps the sender's identity.
 *
 * Teammates' cursors are drawn on an overlay in *our* coordinates
 * (their document position minus our scroll), so they track the content.
 * Follow mode mirrors one tester's page and scroll into our frame.
 */
export function PreviewPane({
  src,
  openHref,
  reloadKey,
  onClose,
  label,
  sessionId,
  testers = [],
  actions = [],
  onReportBug,
  dock,
}: {
  /** the signed frame root, `/preview/t/<token>/` (null while minting) — trailing slash so relative assets resolve */
  src: string | null
  /** the cookie-authenticated root for "open in a new tab" (top-level loads do carry the cookie) */
  openHref: string
  /** bump to force a reload (typically the latest commit seq) */
  reloadKey: number | string
  onClose?: () => void
  label?: string
  /** when set, this viewer's testing is shared with the session */
  sessionId?: string
  testers?: Tester[]
  actions?: TestAction[]
  /** file a bug from the bench (driver → the agent, spectator → a suggestion) */
  onReportBug?: (text: string) => boolean
  /** rendered under the frame (the checks panel) */
  dock?: ReactNode
}) {
  const [manualNonce, setManualNonce] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // where this viewer is inside the frame, RELATIVE to the preview root ("/", "/about.html#faq").
  // Relative paths are what teammates see — never anyone's signed token.
  const [navPath, setNavPath] = useState<string | null>(null)
  const [myPath, setMyPath] = useState<string>('/')
  const [myScroll, setMyScroll] = useState({ x: 0, y: 0 })
  const myPathRef = useRef('/')
  const [own, setOwn] = useState<TestAction[]>([])
  const [followId, setFollowId] = useState<string | null>(null)
  const lastSent = useRef(0)
  // announced to screen readers: only errors and teammates joining — never every click
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    setNavPath(null)
    setMyPath('/')
    myPathRef.current = '/'
    setOwn([])
    setFollowId(null)
  }, [openHref])

  // a followable page: relative, no traversal, no scheme-relative escape
  const inScope = useCallback((p: string | undefined): p is string => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('..'), [])
  // the frame reports absolute pathnames under the signed root; keep only the relative part
  const toRelative = useCallback((p: string | undefined): string | undefined => (src && p && p.startsWith(src) ? `/${p.slice(src.length)}` : undefined), [src])

  const frameSrc = useMemo(() => {
    if (!src) return null
    const base = navPath && navPath !== '/' ? `${src}${navPath.slice(1)}` : src
    const [pathPart, hash = ''] = base.split('#')
    const sep = pathPart!.includes('?') ? '&' : '?'
    return `${pathPart}${sep}_v=${reloadKey}-${manualNonce}${hash ? `#${hash}` : ''}`
  }, [navPath, src, reloadKey, manualNonce])

  useEffect(() => setLoaded(false), [frameSrc])

  const seenTesters = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const t of testers) {
      if (!seenTesters.current.has(t.userId)) {
        seenTesters.current.add(t.userId)
        setAnnouncement(`${t.name} started testing the preview`)
      }
    }
  }, [testers])
  const lastAnnouncedError = useRef<string | null>(null)
  useEffect(() => {
    const err = actions.find((a) => a.kind === 'error')
    if (err && err.id !== lastAnnouncedError.current) {
      lastAnnouncedError.current = err.id
      setAnnouncement(`${err.name} hit an error: ${err.message ?? ''}`)
    }
  }, [actions])

  // brief "updated" flash when a new commit reloads the preview; stay on the same page
  const [flash, setFlash] = useState(false)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (inScope(myPathRef.current) && myPathRef.current !== '/') setNavPath(myPathRef.current)
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1600)
    return () => clearTimeout(t)
  }, [reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // frames from OUR iframe only: record locally, relay to the team
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
      const d = e.data as Record<string, unknown> | null
      if (!d || d.__loom !== 1 || typeof d.kind !== 'string' || !KINDS.has(d.kind)) return
      const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : undefined)
      const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
      const frame: PreviewPresenceFrame = {
        kind: d.kind as PreviewPresenceFrame['kind'],
        x: num(d.x, 1_000_000),
        y: num(d.y, 1_000_000),
        vw: num(d.vw, 100_000),
        vh: num(d.vh, 100_000),
        path: toRelative(str(d.path, 2000)),
        label: str(d.label, 120),
        message: str(d.message, 300),
      }
      if (frame.path) {
        myPathRef.current = frame.path
        setMyPath(frame.path)
      }
      if (frame.kind === 'scroll') setMyScroll({ x: frame.x ?? 0, y: frame.y ?? 0 })
      if (frame.kind === 'click' || frame.kind === 'error' || frame.kind === 'nav') {
        setOwn((prev) => {
          if (frame.kind === 'nav' && prev[0]?.kind === 'nav' && prev[0].path === frame.path) return prev
          const a: TestAction = {
            id: `self-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            userId: 'self',
            name: 'You',
            color: '',
            kind: frame.kind as TestAction['kind'],
            path: frame.path ?? '/',
            label: frame.label,
            message: frame.message,
            at: Date.now(),
          }
          return [a, ...prev].slice(0, TRAIL)
        })
      }
      if (!sessionId) return
      // pointer moves are the only flood risk; keep them under the hub's limit
      const now = Date.now()
      if (frame.kind === 'move' && now - lastSent.current < 60) return
      lastSent.current = now
      wsClient.previewPresence(sessionId, frame)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [sessionId, toRelative])

  // leaving the bench tells teammates our cursor is gone
  useEffect(() => {
    if (!sessionId) return
    return () => wsClient.previewPresence(sessionId, { kind: 'leave' })
  }, [sessionId])

  // follow mode: mirror the followed tester's page, then their scroll
  const followed = followId ? testers.find((t) => t.userId === followId) ?? null : null
  useEffect(() => {
    if (followId && !followed) setFollowId(null)
  }, [followId, followed])
  useEffect(() => {
    if (!followed || !inScope(followed.path)) return
    if (followed.path !== myPathRef.current) {
      myPathRef.current = followed.path
      setNavPath(followed.path)
    }
  }, [followed?.path]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!followed || followed.path !== myPathRef.current) return
    iframeRef.current?.contentWindow?.postMessage({ __loomCmd: 'scrollTo', x: followed.scrollX, y: followed.scrollY }, '*')
  }, [followed?.scrollX, followed?.scrollY, followed?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  const here = testers.filter((t) => t.path === myPath)
  const feed = useMemo(() => [...own, ...actions].sort((a, b) => b.at - a.at).slice(0, 6), [own, actions])
  const recentClicks = actions.filter((a) => a.kind === 'click' && a.path === myPath && Date.now() - a.at < 1500).slice(0, 4)
  const now = useNow(5_000)

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col border-l-2 border-hairline-strong bg-surface">
      {/* bench header: what, where, who */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline-strong px-3">
        <span className="telemetry shrink-0 whitespace-nowrap text-primary">Test bench</span>
        <span className="min-w-0 truncate font-mono text-code-sm text-tertiary" title={label}>
          {myPath}
          {label ? ` · ${label}` : ''}
        </span>
        <span role="status" className="contents">
          {flash && <span className="telemetry bg-ok px-1.5 text-on-accent">Rebuilt</span>}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {testers.length > 0 && (
            <div className="mr-1 flex items-center" role="group" aria-label="Teammates testing — choose one to follow">
              {testers.slice(0, 5).map((t) => (
                <button
                  key={t.userId}
                  type="button"
                  onClick={() => setFollowId((cur) => (cur === t.userId ? null : t.userId))}
                  aria-pressed={followId === t.userId}
                  aria-label={followId === t.userId ? `Stop following ${t.name}` : `Follow ${t.name}`}
                  title={followId === t.userId ? `Stop following ${t.name}` : `Follow ${t.name} — see the page they see`}
                  className={cn(
                    'telemetry -ml-px flex h-6 min-w-6 items-center justify-center border border-hairline-strong px-1 text-primary transition-transform duration-micro hover:-translate-y-px',
                    followId === t.userId && 'shadow-[inset_0_0_0_2px_var(--text-primary)] ring-0',
                  )}
                  style={{ background: identityColor(t.color) }}
                >
                  {t.name.slice(0, 2)}
                </button>
              ))}
            </div>
          )}
          {onReportBug && <BugFlag path={myPath} trail={own} onReport={onReportBug} />}
          <a
            href={`${openHref}${(navPath ?? '/').slice(1)}`}
            target="_blank"
            rel="noreferrer"
            title="Open the preview in a new tab"
            aria-label="Open the preview in a new tab"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary"
          >
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
          </a>
          <IconButton label="Reload the preview" onClick={() => setManualNonce((n) => n + 1)}>
            <RotateCw size={14} strokeWidth={1.75} />
          </IconButton>
          {onClose && (
            <IconButton label="Hide the preview" onClick={onClose}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          )}
        </div>
      </div>

      {followed && (
        <div className="flex h-7 shrink-0 items-center gap-2 bg-primary px-3 text-canvas" role="status">
          <span aria-hidden className="h-2 w-2 animate-pulse bg-signal-500" />
          <span className="telemetry">Following {followed.name}</span>
          <span className="truncate font-mono text-code-sm opacity-70">{displayPath(followed.path)}</span>
          <button type="button" onClick={() => setFollowId(null)} className="telemetry ml-auto underline-offset-2 hover:underline">
            <span aria-hidden>Stop</span>
            <span className="sr-only">Stop following {followed.name}</span>
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-inset">
        {(!loaded || !frameSrc) && (
          <div role="status" className="telemetry absolute inset-0 flex items-center justify-center text-tertiary">
            Loading preview…
          </div>
        )}
        {frameSrc && <iframe
          ref={iframeRef}
          key={frameSrc}
          src={frameSrc}
          title="Live product preview"
          sandbox="allow-scripts"
          onLoad={() => setLoaded(true)}
          className="h-full w-full border-0 bg-white"
        />}
        {/* teammates' pointers, in our coordinates; pointer-events stay with the frame */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          {here.map((t) =>
            t.x === null || t.y === null ? null : (
              <div
                key={t.userId}
                className="absolute left-0 top-0 transition-transform duration-fast ease-linear motion-reduce:transition-none"
                style={{ transform: `translate(${t.x - myScroll.x}px, ${t.y - myScroll.y}px)` }}
              >
                <svg width="14" height="18" viewBox="0 0 14 18" className="drop-shadow-none">
                  <path d="M1 1 L1 15 L5 11 L8 17 L10.5 16 L7.5 10 L13 10 Z" fill={identityColor(t.color)} stroke="#111" strokeWidth="1.5" strokeLinejoin="miter" />
                </svg>
                <span className="telemetry -mt-0.5 ml-3 inline-block border border-[#111] px-1 text-[#111]" style={{ background: identityColor(t.color) }}>
                  {t.name}
                </span>
              </div>
            ),
          )}
          {recentClicks.map((a) =>
            a.x === undefined || a.y === undefined ? null : (
              <span
                key={a.id}
                className="loom-click-ripple absolute h-8 w-8 border-2"
                style={{ left: a.x - myScroll.x - 16, top: a.y - myScroll.y - 16, borderColor: '#111', background: 'transparent' }}
              />
            ),
          )}
        </div>
      </div>

      {/* the live testing feed — what everyone is doing in the product right now */}
      <section aria-label="Live testing" className="shrink-0 border-t-2 border-hairline-strong bg-surface">
        <div className="flex h-7 items-center gap-2 border-b border-hairline px-3">
          <span className="telemetry text-primary">Live testing</span>
          <span className="telemetry text-tertiary">
            {testers.length === 0 ? 'only you' : `${testers.length + 1} testing`}
          </span>
        </div>
        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>
        <ol className="max-h-[132px] overflow-y-auto">
          {feed.length === 0 ? (
            <li className="px-3 py-2 text-small text-tertiary">Click around the preview — teammates see your cursor, clicks and errors live.</li>
          ) : (
            feed.map((a) => (
              <li key={a.id} className={cn('flex items-baseline gap-2 border-b border-hairline px-3 py-1 text-small last:border-b-0', a.kind === 'error' && 'bg-danger-fill')}>
                <span aria-hidden className="h-2 w-2 shrink-0 translate-y-[1px] border border-[#111]" style={{ background: a.userId === 'self' ? 'var(--bg-canvas)' : identityColor(a.color) }} />
                <span className="max-w-[12ch] shrink-0 truncate font-semibold text-primary">{a.name}</span>
                <span className={cn('min-w-0 truncate', a.kind === 'error' ? 'text-danger' : 'text-secondary')}>
                  {a.kind === 'click' ? (
                    <>clicked <span className="font-mono text-code-sm text-primary">{a.label || 'the page'}</span></>
                  ) : a.kind === 'nav' ? (
                    <>opened <span className="font-mono text-code-sm text-primary">{displayPath(a.path)}</span></>
                  ) : (
                    <>hit an error: <span className="font-mono text-code-sm" title={a.message}>{a.message}</span></>
                  )}
                </span>
                <span className="telemetry ml-auto shrink-0 text-tertiary">{now - a.at < 5000 ? 'now' : timeAgo(new Date(a.at).toISOString())}</span>
              </li>
            ))
          )}
        </ol>
      </section>
      {dock}
    </div>
  )
}

/** File a bug from the bench, with the steps that led to it attached. */
function BugFlag({ path, trail, onReport }: { path: string; trail: TestAction[]; onReport: (text: string) => boolean }) {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fieldId = useId()
  const [text, setText] = useState('')
  const steps = [...trail].reverse()
  const submit = () => {
    const what = text.trim()
    if (!what) {
      setErr('Describe the bug first.')
      return
    }
    const repro = steps
      .filter((s) => s.kind !== 'error')
      .map((s, i) => `${i + 1}. ${s.kind === 'click' ? `clicked ${s.label || 'the page'}` : `opened ${displayPath(s.path)}`}`)
    const errors = steps.filter((s) => s.kind === 'error').map((s) => `- ${s.message}`)
    const body = [
      `Bug on ${path}: ${what}`,
      repro.length ? `\nSteps I took:\n${repro.join('\n')}` : '',
      errors.length ? `\nErrors my browser hit:\n${errors.join('\n')}` : '',
    ].join('')
    if (onReport(body)) {
      setText('')
      setErr(null)
      setOpen(false)
    } else {
      setErr('Not sent — the connection dropped. Try again in a second.')
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Flag bug on this page">
          <Bug size={14} strokeWidth={1.75} aria-hidden />
          <span className="hidden xl:inline">Flag bug</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label htmlFor={fieldId} className="telemetry text-primary">
            What&rsquo;s wrong on {path}?
          </label>
          <textarea
            id={fieldId}
            name="bug"
            autoComplete="off"
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${fieldId}-err` : undefined}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (err) setErr(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            }}
            rows={3}
            maxLength={600}
            placeholder="The signup button does nothing…"
            className="loom-input mt-2 resize-none"
          />
          <div className="telemetry mt-2 text-tertiary">
            {steps.length > 0 ? `Attaches your last ${steps.length} step${steps.length === 1 ? '' : 's'}` : 'Click around first to attach repro steps'}
          </div>
          {err && (
            <div id={`${fieldId}-err`} role="alert" className="mt-2 text-small text-danger">
              {err}
            </div>
          )}
          <Button type="submit" variant="primary" size="sm" className="mt-2 w-full">
            File it
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
