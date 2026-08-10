import { describe, expect, it } from 'vitest'
import { InProcessEventBus, type EventBus } from '../src/realtime/bus'
import { RedisEventBus } from '../src/realtime/redisBus'

/**
 * C10 — the EventBus contract, run against every implementation. The Redis
 * adapter runs only when REDIS_URL is present (CI/local without Redis skips
 * it rather than failing).
 */
type Closeable = EventBus & { close?: () => Promise<void> }

function contract(name: string, make: () => Closeable) {
  describe(`EventBus contract — ${name}`, () => {
    it('delivers to all topic subscribers, in order, and unsubscribe stops delivery', async () => {
      const bus = make()
      try {
        const gotA: unknown[] = []
        const gotB: unknown[] = []
        const offA = bus.subscribe('t1', (m) => gotA.push(m))
        bus.subscribe('t1', (m) => gotB.push(m))
        const other: unknown[] = []
        bus.subscribe('t2', (m) => other.push(m))

        bus.publish('t1', { n: 1 })
        bus.publish('t1', { n: 2 })
        await waitFor(() => gotA.length === 2 && gotB.length === 2)

        expect(gotA).toEqual([{ n: 1 }, { n: 2 }])
        expect(gotB).toEqual([{ n: 1 }, { n: 2 }])
        expect(other).toEqual([])

        offA()
        bus.publish('t1', { n: 3 })
        await waitFor(() => gotB.length === 3)
        expect(gotA).toHaveLength(2)
        expect(gotB[2]).toEqual({ n: 3 })
      } finally {
        await bus.close?.()
      }
    })

    it('a throwing handler never breaks other subscribers', async () => {
      const bus = make()
      try {
        const got: unknown[] = []
        bus.subscribe('boom', () => {
          throw new Error('bad subscriber')
        })
        bus.subscribe('boom', (m) => got.push(m))
        bus.publish('boom', 'x')
        await waitFor(() => got.length === 1)
        expect(got).toEqual(['x'])
      } finally {
        await bus.close?.()
      }
    })
  })
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

contract('in-process', () => new InProcessEventBus())

if (process.env.REDIS_URL) {
  contract('redis', () => new RedisEventBus(process.env.REDIS_URL!, `loom:test:${Date.now()}:`))
} else {
  describe('EventBus contract — redis', () => {
    it.skip('set REDIS_URL to run the redis adapter against the same contract', () => {})
  })
}
