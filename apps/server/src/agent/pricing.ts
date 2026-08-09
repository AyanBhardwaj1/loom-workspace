/**
 * Rough published prices (USD per 1M tokens) for the models this app commonly
 * drives, matched by substring. These are ESTIMATES for the cost chip — the
 * point is proportional visibility, not billing accuracy. Update as prices move.
 */
interface Price {
  inputPerM: number
  outputPerM: number
}

const PRICES: Array<{ match: RegExp; price: Price }> = [
  { match: /claude-(3-)?opus|opus-4/i, price: { inputPerM: 15, outputPerM: 75 } },
  { match: /claude-3-5-haiku|claude-haiku|haiku-4/i, price: { inputPerM: 0.8, outputPerM: 4 } },
  { match: /claude.*sonnet|sonnet-4/i, price: { inputPerM: 3, outputPerM: 15 } },
  { match: /gpt-4o-mini|4o-mini/i, price: { inputPerM: 0.15, outputPerM: 0.6 } },
  { match: /gpt-4o|gpt-4\.1/i, price: { inputPerM: 2.5, outputPerM: 10 } },
  { match: /o1|o3/i, price: { inputPerM: 15, outputPerM: 60 } },
  { match: /llama|mistral|qwen|deepseek|gemma/i, price: { inputPerM: 0.2, outputPerM: 0.6 } },
]

const DEFAULT_PRICE: Price = { inputPerM: 3, outputPerM: 15 }

/**
 * Estimate the USD cost of a turn. Mock mode has no real cost, so it returns 0
 * even though token counts are fabricated for UI/testing.
 */
export function estimateCostUsd(
  provider: string,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (provider === 'mock' || !model) return 0
  const price = PRICES.find((p) => p.match.test(model))?.price ?? DEFAULT_PRICE
  const cost = (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM
  return Math.round(cost * 1_000_000) / 1_000_000 // 6dp
}
