import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationRaw } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

/**
 * `loom-charcoal` — the one code theme, shared by static diffs and the
 * magic-move evolution player so highlighting is identical everywhere.
 * This file is the second (and last) sanctioned home for raw hex values,
 * alongside src/styles/tokens.css.
 */
export const loomCharcoal: ThemeRegistrationRaw = {
  name: 'loom-charcoal',
  type: 'dark',
  colors: {
    'editor.background': '#0B0B0D',
    'editor.foreground': '#D2D2D8',
  },
  settings: [
    { settings: { background: '#0B0B0D', foreground: '#D2D2D8' } },
    { scope: ['keyword', 'storage.type', 'storage.modifier', 'keyword.control'], settings: { foreground: '#A9A1F0' } },
    {
      scope: ['string', 'string.quoted', 'punctuation.definition.string', 'markup.inline.raw'],
      settings: { foreground: '#7FBF9E' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'variable.other.property', 'support.type.property-name', 'entity.name.tag'],
      settings: { foreground: '#D2D2D8' },
    },
    { scope: ['constant.numeric', 'constant.language', 'constant.other'], settings: { foreground: '#C9A97A' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#FFFFFF52' } },
    {
      scope: ['punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'],
      settings: { foreground: '#D2D2D880' },
    },
    { scope: ['entity.name.type', 'support.type', 'support.class'], settings: { foreground: '#BDB2F9' } },
    { scope: ['variable', 'variable.parameter'], settings: { foreground: '#EDEDF0' } },
    { scope: ['markup.heading'], settings: { foreground: '#EDEDF0' } },
  ],
}

let corePromise: Promise<HighlighterCore> | null = null

/** Lazy singleton — langs load once, on first code render. */
export function getHighlighter(): Promise<HighlighterCore> {
  corePromise ??= createHighlighterCore({
    themes: [loomCharcoal],
    langs: [
      import('@shikijs/langs/html'),
      import('@shikijs/langs/css'),
      import('@shikijs/langs/javascript'),
      import('@shikijs/langs/typescript'),
      import('@shikijs/langs/tsx'),
      import('@shikijs/langs/json'),
      import('@shikijs/langs/markdown'),
      import('@shikijs/langs/shellscript'),
    ],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  })
  return corePromise
}

const EXT_TO_LANG: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'tsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'shellscript',
  bash: 'shellscript',
}

export function langForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANG[ext] ?? 'text'
}
