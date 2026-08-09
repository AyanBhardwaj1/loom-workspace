import { BRAND, type SessionEvent, type TranscriptEntry } from '@loom/shared'

/**
 * Rebuild a condensed conversation transcript from the persisted event log.
 * This is the model's memory of the session — which is exactly why forking
 * "just works": the copied log reconstructs the same context.
 */
export function buildTranscript(events: SessionEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const e of events) {
    switch (e.type) {
      case 'user_message':
        entries.push({ role: 'user', text: cap(e.payload.text, 2000) })
        break
      case 'assistant_message':
        entries.push({ role: 'assistant', text: cap(e.payload.text, 2000) })
        break
      case 'tool_call':
        entries.push({
          role: 'tool',
          text: `→ ${e.payload.toolName}(${cap(JSON.stringify(e.payload.input), 160)})`,
        })
        break
      case 'tool_result':
        entries.push({ role: 'tool', text: `← ${cap(e.payload.summary, 200)}` })
        break
      case 'commit':
        entries.push({ role: 'tool', text: `✓ committed: ${cap(e.payload.technicalSummary, 200)}` })
        break
      default:
        break
    }
  }
  // keep the tail — old context matters less than recent work
  return entries.slice(-60)
}

export function countAssistantTurns(events: SessionEvent[]): number {
  return events.filter((e) => e.type === 'assistant_message').length
}

export function agentSystemPrompt(input: {
  projectName: string
  moduleName: string
  moduleDescription: string
  driverName: string
}): string {
  return `You are the ${BRAND} coding agent, pair-building the "${input.projectName}" project with ${input.driverName}. You are working inside the "${input.moduleName}" module${input.moduleDescription ? ` (${input.moduleDescription})` : ''}.

Your workspace is a git worktree containing the project's code. You have tools to list, read, write, edit and delete files, and to run a small set of commands.

Rules:
- Make small, coherent, working increments. Every turn should leave the project in a state that runs.
- Prefer plain HTML/CSS/JS or small Node apps so results are immediately viewable.
- Before each tool call, briefly narrate what you are about to do and why (one or two sentences). Teammates watch your work stream live — the narration is what makes it followable.
- Read a file before editing it. Use edit_file for small changes, write_file for new files or rewrites.
- Keep file paths relative. Never try to leave the workspace.
- End the turn with a short summary of what changed.`
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
