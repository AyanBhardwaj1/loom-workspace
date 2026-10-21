import { describe, expect, it } from 'vitest'
import { claudeCaps, CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_SUMMARY_MODEL } from '../src/agent/claudeModels'
import { loadConfig } from '../src/env'
import { estimateCostUsd } from '../src/agent/pricing'

describe('claudeCaps — what each Claude model accepts', () => {
  it('current models get adaptive thinking, summarized display and the full effort ladder', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-haiku-5-5']) {
      const caps = claudeCaps(id)
      expect(caps.adaptiveThinking, id).toBe(true)
      expect(caps.summarizedDisplay, id).toBe(true)
      expect(caps.efforts, id).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    }
  })

  it('4.6 models take adaptive thinking but no display param and no xhigh', () => {
    const caps = claudeCaps('claude-sonnet-4-6')
    expect(caps.adaptiveThinking).toBe(true)
    expect(caps.summarizedDisplay).toBe(false)
    expect(caps.efforts).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('legacy models get no thinking params at all (adaptive would 400 there)', () => {
    for (const id of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'some-unknown-model']) {
      const caps = claudeCaps(id)
      expect(caps.adaptiveThinking, id).toBe(false)
      expect(caps.efforts, id).toEqual([])
    }
  })

  it('server-side refusal fallbacks only where the API accepts the "default" form', () => {
    expect(claudeCaps('claude-opus-5-5').refusalFallbacks).toBe(true)
    expect(claudeCaps('claude-sonnet-5-5').refusalFallbacks).toBe(true)
    expect(claudeCaps('claude-fable-5-1').refusalFallbacks).toBe(true)
    expect(claudeCaps('claude-haiku-5-5').refusalFallbacks).toBe(false)
    expect(claudeCaps('claude-sonnet-4-5').refusalFallbacks).toBe(false)
  })

  it('the picker catalog lists current models with their ladders, default first', () => {
    expect(CLAUDE_MODELS[0]!.id).toBe(DEFAULT_CLAUDE_MODEL)
    for (const m of CLAUDE_MODELS) expect(m.efforts).toEqual(claudeCaps(m.id).efforts)
  })
})

describe('defaults — no retired models', () => {
  it('agent + summary defaults are current-generation ids', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5-5')
    expect(DEFAULT_CLAUDE_SUMMARY_MODEL).toBe('claude-haiku-5-5')
    const config = loadConfig()
    // claude-3-5-haiku was retired 2026-02-19: every summary call 404'd into the template fallback
    expect(config.anthropicSummaryModel).not.toMatch(/3-5-haiku/)
    expect(config.anthropicModel).not.toMatch(/sonnet-4-5/)
  })
})

describe('estimateCostUsd — current prices + prompt caching', () => {
  it('prices current models from the published table', () => {
    // Opus 5.5: $4 in / $20 out per M
    expect(estimateCostUsd('anthropic', 'claude-opus-5-5', 1_000_000, 1_000_000)).toBeCloseTo(24, 5)
    // Opus 4.8 is $5/$25 — NOT the legacy $15/$75 Opus 4 price
    expect(estimateCostUsd('anthropic', 'claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(30, 5)
    expect(estimateCostUsd('anthropic', 'claude-haiku-5-5', 1_000_000, 1_000_000)).toBeCloseTo(0.6, 5)
  })

  it('bills cache reads at the discounted rate and cache writes at 1.25x', () => {
    // Opus 5.5 cache read $0.20/M, write $5/M (1.25 × $4)
    const cost = estimateCostUsd('anthropic', 'claude-opus-5-5', 0, 0, { cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })
    expect(cost).toBeCloseTo(0.2 + 5, 5)
    // a cached prefix is far cheaper than paying full input price for it
    const cached = estimateCostUsd('anthropic', 'claude-opus-5-5', 0, 0, { cacheReadTokens: 1_000_000 })
    const uncached = estimateCostUsd('anthropic', 'claude-opus-5-5', 1_000_000, 0)
    expect(cached).toBeLessThan(uncached / 10)
  })
})
