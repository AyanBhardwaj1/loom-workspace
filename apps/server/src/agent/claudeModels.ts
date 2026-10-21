import type { ClaudeModelDto, ReasoningEffort } from '@loom/shared'

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
/** Commit summaries + merge notes: the cheapest current tier is plenty. */
export const DEFAULT_CLAUDE_SUMMARY_MODEL = 'claude-haiku-5-5'

const ALL_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ClaudeCaps {
  /** accepts thinking: {type: 'adaptive'} (pre-4.6 models 400 on it) */
  adaptiveThinking: boolean
  /** accepts thinking.display — needed to see narration between tool calls on 5.5-era models */
  summarizedDisplay: boolean
  /** output_config.effort levels this model accepts; [] = don't send effort */
  efforts: ReasoningEffort[]
  /** accepts fallbacks: 'default' (beta server-side-fallback-2026-07-01) */
  refusalFallbacks: boolean
}

/**
 * Request-shape capabilities by model id. Unknown ids get the conservative
 * legacy shape — a plain request every model accepts.
 */
export function claudeCaps(model: string): ClaudeCaps {
  const id = model.toLowerCase()
  const legacy: ClaudeCaps = { adaptiveThinking: false, summarizedDisplay: false, efforts: [], refusalFallbacks: false }
  if (/(opus|sonnet)-4-6/.test(id)) {
    return { adaptiveThinking: true, summarizedDisplay: false, efforts: ['low', 'medium', 'high', 'max'], refusalFallbacks: false }
  }
  const current = /fable-5|mythos-5|opus-5|sonnet-5|haiku-5|opus-4-[78]/.test(id)
  if (!current) return legacy
  return {
    adaptiveThinking: true,
    summarizedDisplay: true,
    efforts: ALL_EFFORTS,
    refusalFallbacks: /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(id),
  }
}

/** The Anthropic-tab picker: current models, recommended default first. */
export const CLAUDE_MODELS: ClaudeModelDto[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', blurb: 'Default — best value for agentic coding', promptPrice: 4, completionPrice: 20, defaultEffort: 'medium' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', blurb: 'Faster everyday coding', promptPrice: 2, completionPrice: 10, defaultEffort: 'high' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', blurb: 'Most capable — long, hard tasks', promptPrice: 10, completionPrice: 50, defaultEffort: 'high' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', blurb: 'Cheapest — quick edits', promptPrice: 0.1, completionPrice: 0.5, defaultEffort: 'medium' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', blurb: 'Previous Opus', promptPrice: 5, completionPrice: 25, defaultEffort: 'high' },
].map((m) => ({ ...m, efforts: claudeCaps(m.id).efforts }))
