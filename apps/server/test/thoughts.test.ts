import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProvider, AgentStreamItem, AgentTurnContext, ServerMessage } from '@loom/shared'
import { sumUsage } from '@loom/shared'
import { makeTestServices, makeUser, type TestContext } from './util'

let ctx: TestContext

beforeEach(async () => {
  ctx = await makeTestServices()
})
afterEach(async () => {
  await ctx.cleanup()
})

/** A provider that replays a fixed script, executing tool calls for real. */
function scripted(items: AgentStreamItem[]): AgentProvider {
  return {
    async *runTurn(turn: AgentTurnContext) {
      for (const item of items) {
        yield item
        if (item.kind === 'tool_call') await turn.executeTool(item.name, item.input)
      }
    },
  }
}

async function setup() {
  const { services } = ctx
  const user = await makeUser(services, 'Ayan', 'ayan@thoughts.dev')
  const project = await services.projects.createProject('Thinker', '', user)
  const modules = await services.projects.listModules(project.id)
  const session = await services.sessions.createSession(modules[0]!.id, user)
  return { services, user, session }
}

describe('visible reasoning — thinking stream → thought events', () => {
  it('persists each stretch of thinking as a thought, in order, before the action it explains', async () => {
    const { services, user, session } = await setup()
    services.runtime.provider = scripted([
      { kind: 'thinking', text: 'The page has no footer. ' },
      { kind: 'thinking', text: 'I will add one after main.' },
      { kind: 'tool_call', name: 'write_file', input: { path: 'footer.html', content: '<footer></footer>' } },
      { kind: 'thinking', text: 'Now verify it renders.' },
      { kind: 'delta', text: 'Added the footer.' },
      { kind: 'message_done', fullText: 'Added the footer.' },
    ])

    await (await services.orchestrator.handleUserMessage(session.id, user, 'Add a footer')).done
    const events = await services.sessions.getEvents(session.id, 0)
    const order = events.map((e) => e.type).filter((t) => ['thought', 'tool_call', 'assistant_message'].includes(t))
    expect(order).toEqual(['thought', 'tool_call', 'thought', 'assistant_message'])

    const thoughts = events.filter((e) => e.type === 'thought').map((e) => (e.payload as { text: string }).text)
    // consecutive deltas coalesce into one thought; the flush happens at the next action
    expect(thoughts).toEqual(['The page has no footer. I will add one after main.', 'Now verify it renders.'])
  })

  it('streams thinking_delta live to watchers without persisting it', async () => {
    const { services, user, session } = await setup()
    const live: string[] = []
    services.bus.subscribe(`session:${session.id}`, (raw) => {
      const msg = raw as ServerMessage
      if (msg.t === 'event' && msg.event.type === 'thinking_delta') live.push((msg.event.payload as { text: string }).text)
    })
    services.runtime.provider = scripted([
      { kind: 'thinking', text: 'Planning.' },
      { kind: 'message_done', fullText: '' },
    ])
    await (await services.orchestrator.handleUserMessage(session.id, user, 'Plan it')).done
    expect(live).toEqual(['Planning.'])
    const persisted = await services.sessions.getEvents(session.id, 0)
    expect(persisted.some((e) => e.type === 'thinking_delta')).toBe(false)
    // a turn that only thinks still leaves its thought behind
    expect(persisted.filter((e) => e.type === 'thought')).toHaveLength(1)
  })

  it('caps a runaway thought instead of failing the event write', async () => {
    const { services, user, session } = await setup()
    services.runtime.provider = scripted([
      { kind: 'thinking', text: 'x'.repeat(20_000) },
      { kind: 'message_done', fullText: '' },
    ])
    await (await services.orchestrator.handleUserMessage(session.id, user, 'Think hard')).done
    const thought = (await services.sessions.getEvents(session.id, 0)).find((e) => e.type === 'thought')
    expect((thought!.payload as { text: string }).text.length).toBeLessThanOrEqual(12_000)
  })
})

describe('usage — cache-aware accounting', () => {
  it('records cache reads/writes on the usage event and prices them', async () => {
    const { services, user, session } = await setup()
    services.runtime.provider = scripted([
      { kind: 'usage', inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 20_000 },
      { kind: 'usage', inputTokens: 200, outputTokens: 300, cacheReadTokens: 20_000, cacheWriteTokens: 0 },
      { kind: 'message_done', fullText: 'ok' },
    ])
    services.runtime.mode = 'anthropic'
    services.runtime.model = 'claude-opus-5-5'

    await (await services.orchestrator.handleUserMessage(session.id, user, 'Go')).done
    const events = await services.sessions.getEvents(session.id, 0)
    const usage = events.find((e) => e.type === 'usage')!.payload as Record<string, number | string>
    expect(usage.inputTokens).toBe(1_200)
    expect(usage.outputTokens).toBe(800)
    expect(usage.cacheReadTokens).toBe(20_000)
    expect(usage.cacheWriteTokens).toBe(20_000)
    // 1.2k×$4 + 0.8k×$20 + 20k×$0.20 + 20k×$5 (per M)
    expect(usage.costUsd).toBeCloseTo((1_200 * 4 + 800 * 20 + 20_000 * 0.2 + 20_000 * 5) / 1_000_000, 6)
    expect(sumUsage(events).cacheReadTokens).toBe(20_000)
  })
})
