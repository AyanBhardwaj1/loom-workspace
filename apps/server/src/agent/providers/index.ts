import type { AgentProvider } from '@loom/shared'
import type { ServerConfig } from '../../env'
import { TemplateSummarizer, type Summarizer } from '../summarizer'
import { AnthropicAgentProvider, AnthropicSummarizer, makeAnthropicConflictResolver } from './anthropic'
import { MockAgentProvider } from './mock'

export type ConflictResolver = (filePath: string, conflictedContent: string) => Promise<string | null>

export interface AgentStack {
  provider: AgentProvider
  summarizer: Summarizer
  conflictResolver: ConflictResolver | null
  mode: 'anthropic' | 'mock'
}

/**
 * If ANTHROPIC_API_KEY is set → real Claude. If not → MockAgentProvider.
 * Everything downstream is provider-agnostic and identical in both modes.
 */
export function createAgentStack(config: ServerConfig, opts: { fastMock?: boolean } = {}): AgentStack {
  if (config.anthropicApiKey) {
    return {
      provider: new AnthropicAgentProvider({ apiKey: config.anthropicApiKey, model: config.anthropicModel }),
      summarizer: new AnthropicSummarizer({ apiKey: config.anthropicApiKey, model: config.anthropicSummaryModel }),
      conflictResolver: makeAnthropicConflictResolver(config),
      mode: 'anthropic',
    }
  }
  return {
    provider: new MockAgentProvider({ fast: opts.fastMock }),
    summarizer: new TemplateSummarizer(),
    conflictResolver: null,
    mode: 'mock',
  }
}
