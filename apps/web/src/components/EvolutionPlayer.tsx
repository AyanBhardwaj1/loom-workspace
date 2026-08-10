import { ShikiMagicMovePrecompiled } from '@shikijs/magic-move/react'
import { codeToKeyedTokens, syncTokenKeys, type KeyedTokensInfo } from '@shikijs/magic-move/core'
import '@shikijs/magic-move/style.css'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getHighlighter, langForPath } from '../lib/highlighter'
import { IconButton, Spinner } from './primitives'

/**
 * F4 — the file evolution player: token-level magic-move between a file's
 * successive states. Tokens precompiled once per open so scrubbing is cheap.
 * ← → step · Esc closes. Evolution/replay contexts only — ordinary diffs
 * stay static shiki (DESIGN.md guardrail).
 */
export function EvolutionPlayer({ path, contents, onClose }: { path: string; contents: string[]; onClose: () => void }) {
  const [steps, setSteps] = useState<KeyedTokensInfo[] | null>(null)
  const [step, setStep] = useState(0)

  useEffect(() => {
    let alive = true
    void getHighlighter().then((hl) => {
      if (!alive) return
      const lang = langForPath(path)
      const loaded = hl.getLoadedLanguages()
      const useLang = loaded.includes(lang) ? lang : 'text'
      const compiled: KeyedTokensInfo[] = []
      let prev: KeyedTokensInfo | null = null
      for (const code of contents) {
        let info = codeToKeyedTokens(hl as never, code, { lang: useLang as never, theme: 'loom-charcoal' })
        if (prev) info = syncTokenKeys(prev, info).to
        compiled.push(info)
        prev = info
      }
      setSteps(compiled)
      setStep(compiled.length - 1)
    })
    return () => {
      alive = false
    }
  }, [path, contents])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setStep((s) => Math.max(0, s - 1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setStep((s) => (steps ? Math.min(steps.length - 1, s + 1) : s))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [steps, onClose])

  return (
    <div className="border-t border-hairline bg-inset">
      <div className="flex h-9 items-center gap-1.5 border-b border-hairline px-2">
        <span className="text-small text-tertiary">Step through every saved state of this file</span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Previous state (←)" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            <ChevronLeft size={15} strokeWidth={1.5} />
          </IconButton>
          <span className="tnum font-mono text-code-sm text-secondary">
            {steps ? `${step + 1} / ${steps.length}` : '– / –'}
          </span>
          <IconButton
            label="Next state (→)"
            onClick={() => setStep((s) => (steps ? Math.min(steps.length - 1, s + 1) : s))}
            disabled={!steps || step >= steps.length - 1}
          >
            <ChevronRight size={15} strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>
      <div className="max-h-[480px] overflow-auto p-3 font-mono text-code leading-5">
        {steps ? (
          <ShikiMagicMovePrecompiled
            steps={steps}
            step={step}
            animate
            options={{ duration: 420, stagger: 2, lineNumbers: false }}
          />
        ) : (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}
      </div>
    </div>
  )
}
