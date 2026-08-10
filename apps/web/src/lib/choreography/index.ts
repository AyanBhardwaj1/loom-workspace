import { gsap } from 'gsap'
import { CustomEase } from 'gsap/CustomEase'
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin'
import { Flip } from 'gsap/Flip'
import { MorphSVGPlugin } from 'gsap/MorphSVGPlugin'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'

/**
 * The choreography engine — the ONLY module allowed to import GSAP.
 * Routine UI stays CSS; these are the six cinematic moments (DESIGN.md §3)
 * plus the Flip container-size helper for chip/diff expansion.
 *
 * Every moment: runs once, never blocks input, ≤700ms, and collapses to a
 * ≤180ms fade (or nothing) under prefers-reduced-motion.
 */
gsap.registerPlugin(CustomEase, DrawSVGPlugin, Flip, MorphSVGPlugin, MotionPathPlugin)

CustomEase.create('loom-out', '0.25,1,0.5,1')
CustomEase.create('loom-standard', '0.2,0,0,1')
/** spring flavor reserved for moments (≈ stiffness 210 / damping 24) */
CustomEase.create('loom-spring', 'M0,0 C0.2,0 0.25,1.12 0.45,1.12 0.65,1.12 0.7,1 1,1')

export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/* ----------------------------------------------------------------------------
 * Flip helper — tool chips / diff cards / sidebar expand-collapse.
 * Capture → caller mutates state → animate the size/position difference.
 * ------------------------------------------------------------------------- */
export function flipContainer(el: Element, mutate: () => void): void {
  if (reducedMotion()) {
    mutate()
    return
  }
  const state = Flip.getState(el)
  mutate()
  requestAnimationFrame(() => {
    Flip.from(state, { duration: 0.24, ease: 'loom-standard', nested: true, scale: false })
  })
}

/* ----------------------------------------------------------------------------
 * M1 — Session start: the thread draws itself downward, then the composer
 * focus ring breathes once.
 * ------------------------------------------------------------------------- */
export function momentSessionStart(threadPath: SVGPathElement | SVGLineElement, composerRing?: HTMLElement | null): void {
  if (reducedMotion()) {
    gsap.fromTo(threadPath, { opacity: 0 }, { opacity: 1, duration: 0.18 })
    return
  }
  const tl = gsap.timeline()
  tl.fromTo(threadPath, { drawSVG: '0% 0%' }, { drawSVG: '0% 100%', duration: 0.6, ease: 'loom-out' })
  if (composerRing) {
    tl.fromTo(
      composerRing,
      { opacity: 0 },
      { opacity: 0.6, duration: 0.2, ease: 'loom-standard' },
      '>-0.05',
    ).to(composerRing, { opacity: 0.35, duration: 0.2, ease: 'loom-standard' })
  }
}

/** M1 companion — the composer focus ring breathes once (0 → 0.6 → 0.35 → 0). */
export function momentComposerBreathe(ringEl: HTMLElement): void {
  if (reducedMotion()) return
  gsap
    .timeline()
    .fromTo(ringEl, { opacity: 0 }, { opacity: 0.6, duration: 0.2, ease: 'loom-standard' })
    .to(ringEl, { opacity: 0.35, duration: 0.2, ease: 'loom-standard' })
    .to(ringEl, { opacity: 0, duration: 0.3, ease: 'loom-standard', delay: 0.4 })
}

/* ----------------------------------------------------------------------------
 * M2 — Agent awakens: one soft pulse travels the thread top → newest event.
 * The sustained current is CSS (.thread-current); this is the herald.
 * ------------------------------------------------------------------------- */
export function momentAgentAwakens(container: HTMLElement, travelPx: number): void {
  if (reducedMotion()) return
  const pulse = document.createElement('span')
  pulse.setAttribute('aria-hidden', 'true')
  Object.assign(pulse.style, {
    position: 'absolute',
    left: '-2.5px',
    top: '0px',
    width: '6px',
    height: '6px',
    borderRadius: '999px',
    background: 'var(--lav-500)',
    opacity: '0',
    pointerEvents: 'none',
  })
  container.appendChild(pulse)
  gsap
    .timeline({ onComplete: () => pulse.remove() })
    .to(pulse, { opacity: 0.7, duration: 0.08, ease: 'loom-standard' })
    .to(pulse, { y: travelPx, duration: 0.4, ease: 'loom-standard' }, 0)
    .to(pulse, { opacity: 0, duration: 0.12 }, '>-0.1')
}

/* ----------------------------------------------------------------------------
 * M4 — Commit settle: the node scales onto the thread, a 1px ripple ring
 * expands and fades, content staggers up.
 * ------------------------------------------------------------------------- */
export function momentCommitSettle(node: HTMLElement, ripple: HTMLElement, rows: HTMLElement[]): void {
  if (reducedMotion()) {
    gsap.fromTo([node, ...rows], { opacity: 0 }, { opacity: 1, duration: 0.18 })
    return
  }
  const tl = gsap.timeline()
  tl.fromTo(node, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.32, ease: 'loom-spring' })
  tl.fromTo(
    ripple,
    { scale: 0.4, opacity: 0.5 },
    { scale: 2.2, opacity: 0, duration: 0.3, ease: 'loom-standard' },
    0.05,
  )
  tl.fromTo(
    rows,
    { opacity: 0, y: 4 },
    { opacity: 1, y: 0, duration: 0.22, ease: 'loom-out', stagger: 0.08 },
    0.08,
  )
}

/* ----------------------------------------------------------------------------
 * M3 — The fork (the hero): at the fork point the thread sprouts a bezier
 * branch; the forker's avatar rides it; then the caller navigates.
 * Returns a promise that resolves when the moment completes (or instantly
 * under reduced motion) so navigation can await it.
 * ------------------------------------------------------------------------- */
export function momentFork(anchorEl: HTMLElement, avatarColor: string): Promise<void> {
  if (reducedMotion()) return Promise.resolve()
  return new Promise((resolve) => {
    const rect = anchorEl.getBoundingClientRect()
    const svgNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNS, 'svg')
    const w = 180
    const h = 120
    Object.assign(svg.style, {
      position: 'fixed',
      left: `${rect.left - 6}px`,
      top: `${rect.top + rect.height / 2 - 8}px`,
      width: `${w}px`,
      height: `${h}px`,
      overflow: 'visible',
      pointerEvents: 'none',
      zIndex: '30',
    })
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    svg.setAttribute('aria-hidden', 'true')

    const path = document.createElementNS(svgNS, 'path')
    path.setAttribute('d', `M 6 8 Q 60 8 92 52 T 150 104`)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', avatarColor)
    path.setAttribute('stroke-width', '1.5')
    path.setAttribute('opacity', '0.85')
    svg.appendChild(path)

    const rider = document.createElementNS(svgNS, 'circle')
    rider.setAttribute('r', '5')
    rider.setAttribute('fill', avatarColor)
    svg.appendChild(rider)

    document.body.appendChild(svg)
    gsap
      .timeline({
        onComplete: () => {
          svg.remove()
          resolve()
        },
      })
      .fromTo(path, { drawSVG: '0% 0%' }, { drawSVG: '0% 100%', duration: 0.5, ease: 'loom-spring' })
      .to(
        rider,
        {
          motionPath: { path, alignOrigin: [0.5, 0.5] },
          duration: 0.5,
          ease: 'loom-spring',
        },
        0,
      )
      .to(svg, { opacity: 0, duration: 0.16, ease: 'loom-standard' }, '>-0.02')
  })
}

/* ----------------------------------------------------------------------------
 * M5 — The merge join: the branch thread curves in and fuses with main,
 * with one soft lavender bloom at the junction. Built over the history
 * timeline's SVG paths.
 * ------------------------------------------------------------------------- */
export function momentMergeJoin(branchPath: SVGPathElement, joinedD: string, bloomAt: { x: number; y: number }): Promise<void> {
  if (reducedMotion()) {
    return new Promise((resolve) => {
      gsap.to(branchPath, {
        opacity: 0.4,
        duration: 0.18,
        onComplete: () => {
          branchPath.setAttribute('d', joinedD)
          branchPath.style.opacity = ''
          resolve()
        },
      })
    })
  }
  return new Promise((resolve) => {
    const svg = branchPath.ownerSVGElement
    let bloom: SVGCircleElement | null = null
    if (svg) {
      bloom = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      bloom.setAttribute('cx', String(bloomAt.x))
      bloom.setAttribute('cy', String(bloomAt.y))
      bloom.setAttribute('r', '4')
      bloom.setAttribute('fill', 'var(--lav-500)')
      bloom.setAttribute('opacity', '0')
      svg.appendChild(bloom)
    }
    const tl = gsap.timeline({
      onComplete: () => {
        bloom?.remove()
        resolve()
      },
    })
    tl.to(branchPath, { morphSVG: joinedD, duration: 0.6, ease: 'loom-standard' })
    if (bloom) {
      tl.fromTo(bloom, { opacity: 0, scale: 0.5, transformOrigin: 'center' }, { opacity: 0.4, scale: 1.6, duration: 0.25, ease: 'loom-out' }, 0.3)
      tl.to(bloom, { opacity: 0, scale: 2.4, duration: 0.25, ease: 'loom-standard' })
    }
  })
}

/* ----------------------------------------------------------------------------
 * M6 — Replay glide: the thread's visible extent tracks the scrubber.
 * Direct set while dragging (no tween), micro-ripple on release.
 * ------------------------------------------------------------------------- */
export function replayThreadProgress(path: SVGPathElement | SVGLineElement, fraction: number): void {
  gsap.set(path, { drawSVG: `0% ${Math.max(0, Math.min(1, fraction)) * 100}%` })
}

export function momentReplaySettle(headNode: HTMLElement): void {
  if (reducedMotion()) return
  gsap.fromTo(headNode, { scale: 1.5, opacity: 0.6 }, { scale: 1, opacity: 1, duration: 0.24, ease: 'loom-spring' })
}
