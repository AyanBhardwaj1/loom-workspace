/**
 * Serverless functions may freeze the instance as soon as the response is
 * sent. Work that must outlive its request (an agent turn, flushing realtime
 * messages) registers here; the Vercel entry wires this to `waitUntil`.
 * In a long-running server it's a no-op — the process simply keeps going.
 */
let hook: ((p: Promise<unknown>) => void) | null = null

export function setKeepAlive(fn: ((p: Promise<unknown>) => void) | null): void {
  hook = fn
}

export function keepAlive(p: Promise<unknown>): void {
  hook?.(p.catch(() => {}))
}
