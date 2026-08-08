/**
 * AgentProvider abstraction. The orchestrator (server) is provider-agnostic:
 * it consumes an AsyncIterable of AgentStreamItems and turns them into
 * SessionEvents. Real Claude and the MockAgentProvider implement the same
 * interface, so the entire product behaves identically in both modes.
 */

export type AgentStreamItem =
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; name: string; input: Record<string, unknown> }
  | { kind: 'message_done'; fullText: string }
  | { kind: 'error'; message: string }

export interface AgentToolExecution {
  /** Short human summary for the tool_result event ("Wrote 42 lines to index.html"). */
  summary: string
  ok: boolean
  /** Longer detail for UI expansion (truncated output, error text). */
  detail?: string
  /** Raw content fed back to the model (file contents, command output). */
  content?: string
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool'
  text: string
}

export interface AgentTurnContext {
  sessionId: string
  projectName: string
  moduleName: string
  moduleDescription: string
  driverName: string
  /** The user message that started this turn. */
  userMessage: string
  /** Condensed prior conversation, reconstructed from persisted events. */
  transcript: TranscriptEntry[]
  /** Relative paths of files currently in the session worktree. */
  fileTree: string[]
  /** Number of assistant messages before this turn (playbook cursor for the mock). */
  turnIndex: number
  /**
   * Execute a tool against the session's sandboxed worktree.
   * Contract: the provider yields {kind:'tool_call'} FIRST (so the orchestrator
   * appends the tool_call event), then calls executeTool with the same
   * name/input. The orchestrator appends the tool_result event internally and
   * returns the execution to feed back to the model.
   */
  executeTool(name: string, input: Record<string, unknown>): Promise<AgentToolExecution>
}

export interface AgentProvider {
  runTurn(ctx: AgentTurnContext): AsyncIterable<AgentStreamItem>
}

/** Tool names exposed to the model. */
export const AGENT_TOOL_NAMES = [
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'run_command',
] as const
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]
