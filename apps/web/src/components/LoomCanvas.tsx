import { MeshGradient } from '@paper-design/shaders-react'
import { useEffect, useState } from 'react'

/**
 * The living canvas — one MeshGradient mounted once behind the app root.
 * Charcoal ramp + one barely-lavender charcoal, at whisper amplitude: it must
 * read as atmospheric depth, never as a "mesh gradient". The body's CSS
 * radial-gradient (index.css) is the identical-reading fallback for first
 * paint and no-WebGL environments.
 *
 * Discipline:
 *  - DPR capped ≈1.5 via maxPixelCount
 *  - speed 0 while the tab is hidden (visibilitychange)
 *  - reduced motion → speed 0 with a fixed frame (deterministic still)
 */
const COLORS = ['#0B0B0E', '#101014', '#16161A', '#191627']

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export function LoomCanvas() {
  const [hidden, setHidden] = useState(() => document.hidden)
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [webgl] = useState(webglAvailable)

  useEffect(() => {
    const onVis = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMq = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onMq)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      mq.removeEventListener('change', onMq)
    }
  }, [])

  // body's CSS gradient already paints the fallback
  if (!webgl) return null

  const still = hidden || reduced

  return (
    <MeshGradient
      colors={COLORS}
      distortion={0.35}
      swirl={0.08}
      speed={still ? 0 : 0.08}
      frame={reduced ? 4200 : undefined}
      grainMixer={0.03}
      grainOverlay={0.03}
      maxPixelCount={Math.round(1920 * 1200 * 1.5 * 1.5)}
      style={{ position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none' }}
      aria-hidden
    />
  )
}
