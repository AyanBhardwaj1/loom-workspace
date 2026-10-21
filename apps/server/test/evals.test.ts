import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentStreamItem } from '@loom/shared'
import { EVAL_TASKS, runEvalSuite, summarize, type EvalTask } from '../src/evals/harness'

/** A provider that performs scripted tool calls (keyed by task prompt). */
function scriptedProvider(script: Record<string, AgentStreamItem[]>): AgentProvider {
  return {
    async *runTurn(ctx) {
      const steps = script[ctx.userMessage] ?? []
      for (const item of steps) {
        yield item
        if (item.kind === 'tool_call') await ctx.executeTool(item.name, item.input)
      }
      yield { kind: 'usage', inputTokens: 100, outputTokens: 20 }
      yield { kind: 'message_done', fullText: 'done' }
    },
  }
}

const task = (name: string): EvalTask => EVAL_TASKS.find((t) => t.name === name)!

describe('eval harness', () => {
  it('ships a suite of code-graded tasks with unique names', () => {
    expect(EVAL_TASKS.length).toBeGreaterThanOrEqual(5)
    expect(new Set(EVAL_TASKS.map((t) => t.name)).size).toBe(EVAL_TASKS.length)
  })

  it('grades a correct targeted edit as a pass and a sloppy one as a fail', async () => {
    const t = task('targeted-edit')
    const good = scriptedProvider({
      [t.prompt]: [
        { kind: 'tool_call', name: 'edit_file', input: { path: 'styles.css', old_string: '.btn { color: red; }', new_string: '.btn { color: blue; }' } },
      ],
    })
    const sloppy = scriptedProvider({
      [t.prompt]: [{ kind: 'tool_call', name: 'edit_file', input: { path: 'styles.css', old_string: 'red', new_string: 'blue', replace_all: true } }],
    })
    const [goodRun] = await runEvalSuite({ provider: good, tasks: [t], trials: 1 })
    const [badRun] = await runEvalSuite({ provider: sloppy, tasks: [t], trials: 1 })
    expect(goodRun!.trials[0]!.pass).toBe(true)
    expect(badRun!.trials[0]!.pass).toBe(false)
    expect(badRun!.trials[0]!.reason).toMatch(/\.link/)
  })

  it('the sandbox task passes when the escape is refused (nothing lands outside)', async () => {
    const t = task('stays-in-sandbox')
    const attempt = scriptedProvider({
      [t.prompt]: [{ kind: 'tool_call', name: 'write_file', input: { path: '../escaped.txt', content: 'x' } }],
    })
    const [run] = await runEvalSuite({ provider: attempt, tasks: [t], trials: 1 })
    expect(run!.trials[0]!.pass).toBe(true)
  })

  it('aggregates pass@k (any trial) and pass^k (every trial) per task', () => {
    const summary = summarize([
      { task: 'a', trials: [{ pass: true, reason: '', inputTokens: 10, outputTokens: 1, ms: 1 }, { pass: false, reason: 'x', inputTokens: 10, outputTokens: 1, ms: 1 }] },
      { task: 'b', trials: [{ pass: true, reason: '', inputTokens: 10, outputTokens: 1, ms: 1 }, { pass: true, reason: '', inputTokens: 10, outputTokens: 1, ms: 1 }] },
    ])
    expect(summary.tasks).toEqual([
      { task: 'a', passAtK: true, passHatK: false, passRate: 0.5 },
      { task: 'b', passAtK: true, passHatK: true, passRate: 1 },
    ])
    expect(summary.passAtK).toBe(1)
    expect(summary.passHatK).toBe(0.5)
    expect(summary.inputTokens).toBe(40)
  })
})

describe('eval harness — infrastructure failures are not scores', () => {
  const unreachable: AgentProvider = {
    async *runTurn() {
      yield { kind: 'error', message: 'Anthropic rejected the API key — update it in ⚙ AI provider.' }
    },
  }

  it('a trial whose request never reached the model fails as infra, even when the grader would pass', async () => {
    const [run] = await runEvalSuite({ provider: unreachable, tasks: [task('stays-in-sandbox')], trials: 1 })
    expect(run!.trials[0]!.pass).toBe(false)
    expect(run!.trials[0]!.infra).toBe(true)
    expect(run!.trials[0]!.reason).toMatch(/never reached the model/)
  })

  it('stops the suite at the first infrastructure failure instead of burning through every task', async () => {
    const runs = await runEvalSuite({ provider: unreachable, trials: 3 })
    expect(runs.flatMap((r) => r.trials)).toHaveLength(1)
  })
})
