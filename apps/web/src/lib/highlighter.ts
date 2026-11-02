import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationRaw } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

/**
 * `loom-print` — the one code theme: carbon ink on documentation paper,
 * shared by static diffs and the magic-move evolution player. This file is
 * the second (and last) sanctioned home for raw hex values, alongside
 * src/styles/tokens.css. Every foreground clears 4.5:1 on #E9E8E2.
 */
export const loomPrint: ThemeRegistrationRaw = {
  name: 'loom-print',
  type: 'light',
  colors: {
    'editor.background': '#E9E8E2',
    'editor.foreground': '#1A1A18',
  },
  settings: [
    { settings: { background: '#E9E8E2', foreground: '#1A1A18' } },
    { scope: ['keyword', 'storage.type', 'storage.modifier', 'keyword.control'], settings: { foreground: '#111111', fontStyle: 'bold' } },
    {
      scope: ['string', 'string.quoted', 'punctuation.definition.string', 'markup.inline.raw'],
      settings: { foreground: '#1C6B33' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'variable.other.property', 'support.type.property-name', 'entity.name.tag'],
      settings: { foreground: '#111111' },
    },
    { scope: ['constant.numeric', 'constant.language', 'constant.other'], settings: { foreground: '#7A4F00' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#5F5E58', fontStyle: 'italic' } },
    {
      scope: ['punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'],
      settings: { foreground: '#4A4944' },
    },
    { scope: ['entity.name.type', 'support.type', 'support.class'], settings: { foreground: '#9E0D0D' } },
    { scope: ['variable', 'variable.parameter'], settings: { foreground: '#1A1A18' } },
    { scope: ['markup.heading'], settings: { foreground: '#111111', fontStyle: 'bold' } },
  ],
}

let corePromise: Promise<HighlighterCore> | null = null

/** Lazy singleton — langs load once, on first code render. */
export function getHighlighter(): Promise<HighlighterCore> {
  corePromise ??= createHighlighterCore({
    themes: [loomPrint],
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
