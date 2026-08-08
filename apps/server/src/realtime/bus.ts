/**
 * In-process pub/sub. The agent runtime appends events → bus → (a) already
 * persisted by the session service, (b) fanned out to WS subscribers.
 *
 * Kept behind an interface on purpose: for a multi-instance deployment, a
 * Redis-backed adapter (publish → Redis pub/sub → local subscribers) slots in
 * here without touching any caller.
 */

export type BusHandler<T = unknown> = (message: T) => void

export interface EventBus {
  publish(topic: string, message: unknown): void
  subscribe(topic: string, handler: BusHandler): () => void
}

export const sessionTopic = (sessionId: string) => `session:${sessionId}`
export const projectTopic = (projectId: string) => `project:${projectId}`

export class InProcessEventBus implements EventBus {
  private handlers = new Map<string, Set<BusHandler>>()

  publish(topic: string, message: unknown): void {
    const set = this.handlers.get(topic)
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(message)
      } catch (err) {
        // a bad subscriber must never break the publisher
        console.error(`[bus] handler error on ${topic}:`, err)
      }
    }
  }

  subscribe(topic: string, handler: BusHandler): () => void {
    let set = this.handlers.get(topic)
    if (!set) {
      set = new Set()
      this.handlers.set(topic, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(topic)
    }
  }
}
