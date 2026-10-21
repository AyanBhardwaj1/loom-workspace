/**
 * Published prices (USD per 1M tokens) for the models this app commonly
 * drives, matched by substring — first match wins, so specific ids precede
 * family catch-alls. These are ESTIMATES for the cost chip: proportional
 * visibility, not billing. Cache writes bill at 1.25× input (5-minute TTL).
 */
interface Price {
  inputPerM: number
  outputPerM: number
  /** defaults to 0.1× input when the provider publishes no explicit rate */
  cacheReadPerM?: number
}

const PRICES: Array<{ match: RegExp; price: Price }> = [
  { match: /fable-5-1|mythos-5-1/i, price: { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25 } },
  { match: /fable-5|mythos-5/i, price: { inputPerM: 10, outputPerM: 50 } },
  { match: /opus-5-5|opus-5\.5/i, price: { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2 } },
  { match: /opus-5|opus-4-[5-8]|opus-4\.[5-8]/i, price: { inputPerM: 5, outputPerM: 25 } },
  { match: /claude-(3-)?opus|opus-4/i, price: { inputPerM: 15, outputPerM: 75 } },
  { match: /haiku-5/i, price: { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 } },
  { match: /haiku-4/i, price: { inputPerM: 1, outputPerM: 5 } },
  { match: /claude-3-5-haiku|claude-haiku/i, price: { inputPerM: 0.8, outputPerM: 4 } },
  { match: /sonnet-5/i, price: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 } },
  { match: /claude.*sonnet|sonnet-4/i, price: { inputPerM: 3, outputPerM: 15 } },
  { match: /gpt-4o-mini|4o-mini/i, price: { inputPerM: 0.15, outputPerM: 0.6 } },
  { match: /gpt-4o|gpt-4\.1/i, price: { inputPerM: 2.5, outputPerM: 10 } },
  { match: /o1|o3/i, price: { inputPerM: 15, outputPerM: 60 } },
  { match: /llama|mistral|qwen|deepseek|gemma/i, price: { inputPerM: 0.2, outputPerM: 0.6 } },
]

const DEFAULT_PRICE: Price = { inputPerM: 3, outputPerM: 15 }
const CACHE_WRITE_MULTIPLIER = 1.25

export interface CacheTokens {
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Estimate the USD cost of a turn. `inputTokens` is the UNCACHED input (the
 * Anthropic usage convention); cache reads/writes are priced separately.
 * Mock mode has no real cost, so it returns 0 even though token counts are
 * fabricated for UI/testing.
 */
export function estimateCostUsd(
  provider: string,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cache: CacheTokens = {},
): number {
  if (provider === 'mock' || !model) return 0
  const price = PRICES.find((p) => p.match.test(model))?.price ?? DEFAULT_PRICE
  const cacheReadPerM = price.cacheReadPerM ?? price.inputPerM * 0.1
  const cost =
    (inputTokens / 1_000_000) * price.inputPerM +
    (outputTokens / 1_000_000) * price.outputPerM +
    ((cache.cacheReadTokens ?? 0) / 1_000_000) * cacheReadPerM +
    ((cache.cacheWriteTokens ?? 0) / 1_000_000) * price.inputPerM * CACHE_WRITE_MULTIPLIER
  return Math.round(cost * 1_000_000) / 1_000_000 // 6dp
}
