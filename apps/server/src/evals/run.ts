/**
 * pnpm --filter @loom/server eval [--provider mock|anthropic|openrouter]
 *   [--model ID] [--effort low|medium|high|xhigh|max] [--trials K]
 *   [--task NAME] [--yes]
 *
 * Real providers spend real money, so they refuse to run without --yes.
 * Keys come from ANTHROPIC_API_KEY / OPENROUTER_API_KEY — never from the
 * app database. Exit code 1 when any task fails pass^k.
 */
import { parseArgs } from 'node:util'
import type { AgentProvider } from '@loom/shared'
import '../env'
import { DEFAULT_CLAUDE_MODEL } from '../agent/claudeModels'
import { estimateCostUsd } from '../agent/pricing'
import { AnthropicAgentProvider } from '../agent/providers/anthropic'
import { MockAgentProvider } from '../agent/providers/mock'
import { OpenAICompatProvider } from '../agent/providers/openrouter'
import { DEFAULT_OPENROUTER_MODEL } from '../agent/runtime'
import { EVAL_TASKS, runEvalSuite, summarize } from './harness'

// pnpm forwards the `--` separator itself; parseArgs would reject it as positional
const argv = process.argv.slice(2)
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    provider: { type: 'string', default: 'mock' },
    model: { type: 'string' },
    effort: { type: 'string' },
    trials: { type: 'string', default: '1' },
    task: { type: 'string' },
    yes: { type: 'boolean', default: false },
  },
})

function buildProvider(): { provider: AgentProvider; model: string | null } {
  switch (values.provider) {
    case 'mock':
      return { provider: new MockAgentProvider({ fast: true }), model: null }
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
      const model = values.model ?? DEFAULT_CLAUDE_MODEL
      return { provider: new AnthropicAgentProvider({ apiKey, model, effort: values.effort ?? null }), model }
    }
    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY
      if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')
      const model = values.model ?? DEFAULT_OPENROUTER_MODEL
      return { provider: new OpenAICompatProvider({ apiKey, model, reasoning: values.effort ?? null }), model }
    }
    default:
      throw new Error(`unknown --provider ${values.provider}`)
  }
}

async function main(): Promise<void> {
  const trials = Math.max(1, Number.parseInt(values.trials ?? '1', 10) || 1)
  const tasks = values.task ? EVAL_TASKS.filter((t) => t.name === values.task) : EVAL_TASKS
  if (tasks.length === 0) throw new Error(`no task named ${values.task} (have: ${EVAL_TASKS.map((t) => t.name).join(', ')})`)
  if (values.provider !== 'mock' && !values.yes) {
    console.error(
      `This runs ${tasks.length * trials} real agent turn(s) on ${values.provider} and spends real money.\nRe-run with --yes to confirm.`,
    )
    process.exit(2)
  }
  const { provider, model } = buildProvider()
  console.log(`evals: ${tasks.length} task(s) × ${trials} trial(s) on ${values.provider}${model ? ` (${model})` : ''}\n`)

  const runs = await runEvalSuite({
    provider,
    tasks,
    trials,
    onTrial: (task, i, r) =>
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${task}#${i + 1}  ${(r.ms / 1000).toFixed(1)}s  ${r.pass ? '' : r.reason}`),
  })
  const infra = runs.flatMap((r) => r.trials).find((t) => t.infra)
  if (infra) {
    console.error(`\nAborted: ${infra.reason}\nNo score — fix the provider and re-run.`)
    process.exit(2)
  }
  const s = summarize(runs)
  console.log('')
  for (const t of s.tasks) console.log(`  ${t.task.padEnd(20)} pass rate ${(t.passRate * 100).toFixed(0)}%`)
  console.log(`\npass@${trials} ${(s.passAtK * 100).toFixed(0)}% · pass^${trials} ${(s.passHatK * 100).toFixed(0)}%`)
  const cost = estimateCostUsd(values.provider ?? 'mock', model, s.inputTokens, s.outputTokens, {
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
  })
  console.log(
    `tokens ${s.inputTokens.toLocaleString()} in (+${s.cacheReadTokens.toLocaleString()} cached) / ${s.outputTokens.toLocaleString()} out · ≈$${cost.toFixed(4)}`,
  )
  process.exit(s.passHatK === 1 ? 0 : 1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
