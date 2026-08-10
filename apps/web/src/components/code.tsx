import { useEffect, useMemo, useState } from 'react'
import type { ThemedToken } from '@shikijs/types'
import { getHighlighter, langForPath } from '../lib/highlighter'

/**
 * Shiki-backed line rendering for diff cards and file views. One highlight
 * call per document; before tokens arrive the plain text renders in the
 * exact same mono metrics, so highlighting causes zero layout shift.
 */
export function useHighlightedLines(code: string, path: string): ThemedToken[][] | null {
  const lang = useMemo(() => langForPath(path), [path])
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)

  useEffect(() => {
    let alive = true
    setTokens(null)
    if (!code) {
      setTokens([])
      return
    }
    void getHighlighter().then((hl) => {
      if (!alive) return
      try {
        const loaded = hl.getLoadedLanguages()
        const useLang = loaded.includes(lang) ? lang : 'text'
        const result = hl.codeToTokensBase(code, { lang: useLang as never, theme: 'loom-charcoal' })
        if (alive) setTokens(result)
      } catch {
        if (alive) setTokens([])
      }
    })
    return () => {
      alive = false
    }
  }, [code, lang])

  return tokens
}

export function TokenLine({ tokens, fallback }: { tokens: ThemedToken[] | undefined; fallback: string }) {
  if (!tokens) return <>{fallback || ' '}</>
  if (tokens.length === 0) return <>{' '}</>
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
    </>
  )
}
