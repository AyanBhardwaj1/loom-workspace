/**
 * Streaming presence in the browser chrome: while any session the user has
 * open is streaming, the favicon swaps to its lavender variant and the tab
 * title gains a "● " prefix. Small, noticeable, honest.
 */
let streaming = false
let baseTitle: string | null = null

export function setBrowserStreamingIndicator(on: boolean): void {
  if (on === streaming) return
  streaming = on

  const link = document.getElementById('favicon') as HTMLLinkElement | null
  if (link) link.href = on ? '/favicon-live.svg' : '/favicon.svg'

  baseTitle ??= document.title.replace(/^● /, '')
  if (!on) baseTitle = document.title.replace(/^● /, '')
  document.title = on ? `● ${baseTitle}` : baseTitle
}
