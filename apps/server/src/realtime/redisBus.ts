import Redis from 'ioredis'
import type { BusHandler, EventBus } from './bus'

/**
 * C10 — the multi-instance path: an EventBus backed by Redis pub/sub. Every
 * instance publishes to Redis; every instance's local subscribers receive
 * every message (including its own, mirroring the in-process semantics).
 *
 * Config-gated by REDIS_URL in services.ts; the in-process bus stays the
 * zero-dependency default. Note: presence remains per-instance (it derives
 * from live sockets) — see DEPLOY.md.
 */
export class RedisEventBus implements EventBus {
  private pub: Redis
  private sub: Redis
  private handlers = new Map<string, Set<BusHandler>>()
  private ready: Promise<void>

  constructor(url: string, keyPrefix = 'loom:bus:') {
    this.pub = new Redis(url, { lazyConnect: true })
    this.sub = new Redis(url, { lazyConnect: true })
    this.prefix = keyPrefix
    this.ready = Promise.all([this.pub.connect(), this.sub.connect()]).then(() => {
      this.sub.on('message', (channel: string, raw: string) => {
        const topic = channel.startsWith(this.prefix) ? channel.slice(this.prefix.length) : channel
        const set = this.handlers.get(topic)
        if (!set) return
        let message: unknown
        try {
          message = JSON.parse(raw)
        } catch {
          return
        }
        for (const handler of [...set]) {
          try {
            handler(message)
          } catch (err) {
            console.error(`[redis-bus] handler error on ${topic}:`, err)
          }
        }
      })
    })
  }

  private prefix: string

  publish(topic: string, message: unknown): void {
    void this.ready.then(() => this.pub.publish(this.prefix + topic, JSON.stringify(message)))
  }

  subscribe(topic: string, handler: BusHandler): () => void {
    let set = this.handlers.get(topic)
    if (!set) {
      set = new Set()
      this.handlers.set(topic, set)
      void this.ready.then(() => this.sub.subscribe(this.prefix + topic))
    }
    set.add(handler)
    return () => {
      const s = this.handlers.get(topic)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) {
        this.handlers.delete(topic)
        void this.ready.then(() => this.sub.unsubscribe(this.prefix + topic))
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()])
  }
}
