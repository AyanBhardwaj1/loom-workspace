import { describe, expect, it } from 'vitest'
import { createAgentStack } from '../src/agent/providers'
import { AnthropicAgentProvider, AnthropicSummarizer } from '../src/agent/providers/anthropic'
import { MockAgentProvider } from '../src/agent/providers/mock'
import { TemplateSummarizer } from '../src/agent/summarizer'
import { loadConfig } from '../src/env'

describe('provider selection', () => {
  it('uses the mock stack when no ANTHROPIC_API_KEY is set', () => {
    const stack = createAgentStack(loadConfig({ anthropicApiKey: null }))
    expect(stack.mode).toBe('mock')
    expect(stack.provider).toBeInstanceOf(MockAgentProvider)
    expect(stack.summarizer).toBeInstanceOf(TemplateSummarizer)
    expect(stack.conflictResolver).toBeNull()
  })

  it('switches to real Claude with zero other changes when the key is set', () => {
    const stack = createAgentStack(
      loadConfig({ anthropicApiKey: 'sk-test-not-real', anthropicModel: 'claude-sonnet-4-5' }),
    )
    expect(stack.mode).toBe('anthropic')
    expect(stack.provider).toBeInstanceOf(AnthropicAgentProvider)
    expect(stack.summarizer).toBeInstanceOf(AnthropicSummarizer)
    expect(typeof stack.conflictResolver).toBe('function')
  })
})
