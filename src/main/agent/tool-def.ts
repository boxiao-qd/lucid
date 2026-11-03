// ToolDef — shared shape for all agent tools.

import type { Emit } from './event-bus'
import type { MessageExpertRef } from '../../shared/subagent-types'

export interface ToolExecContext {
  sessionId: string
  emit: Emit
  abortSignal: AbortSignal
  toolCallId?: string
  /**
   * Parent (main) session ID. Set when the tool is executed inside a sub-agent
   * loop. Tools like save_product use this to save files under the parent
   * session's product directory so they're visible in the main UI file list.
   */
  parentSessionId?: string
  /**
   * TaskRun ID — unique per expert invocation. When set, product files are
   * isolated in a subfolder named after the runId so that multiple
   * invocations of the same expert in one session don't overwrite each other.
   */
  runId?: string
  /**
   * Out-parameter: tools that spawn a sub-agent (session_spawn) set this on
   * the context so the agent-runner can attach the expert ref to the
   * tool_call message persisted to the main session JSONL.
   */
  expertRef?: MessageExpertRef
}

export interface OpenAIToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolDef {
  name: string
  openai: OpenAIToolDef
  execute: (argsStr: string, ctx: ToolExecContext) => Promise<string>
}
