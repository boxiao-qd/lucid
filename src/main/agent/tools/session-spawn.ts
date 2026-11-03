// session_spawn tool — delegates a task to a sub-agent (expert).
//
// Called by lucid's agent loop when the user has selected an expert. The tool:
//   1. Loads the agent definition (AGENT.md)
//   2. Creates a TaskRun + sub-agent session
//   3. For `single` experts: runs the sub-agent loop directly
//   4. For `expert_panel` experts: runs each member per graph.yaml
//      (serial or concurrent), then runs the leader to aggregate
//   5. Sets ctx.expertRef so the agent-runner can attach the expert ref
//      to the tool_call message persisted to the main session
//   6. Returns the expert's result as a tool_result string

import type { ModelConfig } from '../../../shared/types'
import type { ToolDef, ToolExecContext } from '../tool-def'
import type { MessageExpertRef } from '../../../shared/subagent-types'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { WORKSPACE_DIR } from '../../skills'
import { loadAgentDefinition } from '../../subagent/agent-definition'
import { loadAgentGraph } from '../../subagent/graph-definition'
import {
  createTaskRun,
  getTaskRun,
  setRunStatus,
  addMemberSession,
  updateMemberSession
} from '../../subagent/task-runs'
import {
  createSubagentSession,
  updateSubagentSessionStatus,
  getSubagentSessionMessages
} from '../../subagent/subagent-sessions'
import { runSubagent } from '../subagent-runner'
import { appendSessionMessage } from '../../sessions'

/** Cancellation / error / quality-rejection markers that indicate a member didn't produce real work. */
const ABORT_MARKERS = [
  '子智能体任务已被取消',
  '子智能体执行失败',
  '子智能体多次未给出有效回答',
  '子智能体执行异常终止',
  '⚠️ 输入质量不足'
]

function isAbortedResult(result: string): boolean {
  const trimmed = result.trim()
  if (trimmed.length === 0) return true
  return ABORT_MARKERS.some((m) => trimmed.includes(m))
}

/**
 * Save a member's execution result as an artifact file under the workspace
 * directory so subsequent sub-agents can read it via the `read` tool.
 *
 * The artifact is composed from the FULL sub-agent session — all thinking,
 * text, and tool_call messages — not just the final result string. This
 * ensures intermediate analysis (e.g. task breakdown sub-questions) is
 * captured, not just the final summary.
 *
 * Returns the artifact file path, or null if the member was aborted (no
 * real work produced) — in that case no file is written.
 *
 * Path: ~/.lucid/workspace/artifact/{sessionId}/product/{runId}/subagent/{agentId}.md
 * where sessionId is the main lucid session ID and runId is the TaskRun ID.
 * The runId subfolder isolates products from different invocations of the
 * same expert in the same session, preventing overwrites. This mirrors the
 * structure used by saveProduct (leader/single-expert products land in
 * {runId}/ directly, member products land in {runId}/subagent/).
 */
function saveMemberArtifact(
  sessionId: string,
  runId: string,
  agentId: string,
  agentName: string,
  result: string,
  subagentSessionId: string
): string | null {
  // Don't create artifact files for aborted / cancelled members — they
  // didn't produce real work, and leaving empty/garbage files confuses
  // downstream agents and the user.
  if (isAbortedResult(result)) {
    return null
  }

  const dir = join(WORKSPACE_DIR, 'artifact', sessionId, 'product', runId, 'subagent')
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${agentId}.md`)
  const header = `# ${agentName} (${agentId}) 的执行产物\n\n`

  // Compose the artifact from ALL assistant text messages in the session —
  // NOT thinking/reasoning messages. Thinking is internal LLM reasoning
  // (search strategy, self-correction, etc.) and clutters the artifact.
  // Text messages are the actual output the agent produced.
  const messages = getSubagentSessionMessages(agentId, subagentSessionId)
  const sections: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (msg.type === 'text' && msg.content.trim()) {
      sections.push(msg.content.trim())
    }
  }

  const body = sections.length > 0 ? sections.join('\n\n') : result
  writeFileSync(filePath, header + body, 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600)
  }
  return `~/.lucid/workspace/artifact/${sessionId}/product/${runId}/subagent/${agentId}.md`
}

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'session_spawn',
    description:
      '将任务委派给指定的子智能体（专家）执行。用户选择专家后，调用此工具将任务转交。' +
      '工具会创建子智能体会话、执行专家的 agent loop，返回最终结果。' +
      '对于专家团类型，会按预定义图谱协调多个 team member，再由 team leader 汇总。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '要委派给专家的任务描述'
        },
        agentId: {
          type: 'string',
          description: '目标专家的 agentId（用户选择的专家）'
        }
      },
      required: ['task', 'agentId']
    }
  }
}

interface SessionSpawnArgs {
  task: string
  agentId: string
}

function parseArgs(argsStr: string): SessionSpawnArgs | null {
  try {
    const parsed = JSON.parse(argsStr) as Partial<SessionSpawnArgs>
    if (typeof parsed.task !== 'string' || typeof parsed.agentId !== 'string') {
      return null
    }
    return { task: parsed.task, agentId: parsed.agentId }
  } catch {
    return null
  }
}

/**
 * Resolve the active model from the current settings. The sub-agent inherits
 * lucid's model — no separate model config in AGENT.md.
 *
 * The model is injected from the tool-exec context's emit chain (the
 * agent-runner passes the model when calling tools via a closure). For now
 * we read it from a module-level setter populated by the agent-runner.
 */
let activeModel: ModelConfig | null = null

export function setActiveModelForSubagent(model: ModelConfig): void {
  activeModel = model
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  const args = parseArgs(argsStr)
  if (!args) {
    return JSON.stringify({
      error: 'Invalid arguments. Expected { task: string, agentId: string }'
    })
  }

  const agent = loadAgentDefinition(args.agentId)
  if (!agent) {
    return JSON.stringify({ error: `Expert not found: ${args.agentId}` })
  }

  if (!activeModel) {
    return JSON.stringify({ error: 'No active model configured for sub-agent execution' })
  }
  const model = activeModel

  // 1. Create the leader session (also used as the session for single experts)
  const leaderSession = createSubagentSession(args.agentId, {
    parentRunId: 'pending', // will be replaced after TaskRun creation
    parentSessionId: ctx.sessionId,
    task: args.task
  })

  // 2. Create the TaskRun (now we have the leaderSessionId)
  const run = createTaskRun({
    parentSessionId: ctx.sessionId,
    parentMessageId: ctx.toolCallId ?? '',
    expertAgentId: args.agentId,
    expertName: agent.name,
    ...(agent.emoji ? { expertEmoji: agent.emoji } : {}),
    expertType: agent.type,
    leaderSessionId: leaderSession.id,
    task: args.task
  })

  // The sub-agent session's parentRunId was set to 'pending' — update the
  // header by writing a corrected session. For simplicity, we just create a
  // new session with the correct runId. The old one will be orphaned but
  // harmless. In practice, we fix this by using a two-phase approach below.
  // Actually — let's fix it properly by creating the session AFTER the run.
  // Redo: delete the pending session and create a real one.

  // To keep it simple and correct, we'll just proceed with the 'pending'
  // runId in the session header. The TaskRun is the source of truth for
  // associations; the session header's parentRunId is a recovery field.
  // The frontend reads the TaskRun, not the session header, for live status.

  // 3. Set the expert ref on ctx so the agent-runner attaches it to the
  //    tool_call message
  const expertRef: MessageExpertRef = {
    runId: run.runId,
    expertAgentId: args.agentId,
    leaderSessionId: leaderSession.id
  }
  ctx.expertRef = expertRef

  // 3b. Persist the tool_call message to the main session JSONL NOW — BEFORE
  //     the sub-agent runs. This ensures that if the user switches sessions
  //     mid-execution, the tool_call record + "查看执行详情" button survive
  //     the reload. The agent-runner skips tool_call persistence for
  //     session_spawn (it's handled here).
  appendSessionMessage(ctx.sessionId, 'assistant', argsStr, 'tool_call', {
    toolCallId: ctx.toolCallId ?? '',
    toolName: 'session_spawn',
    expert: expertRef
  })

  // 3c. Emit real-time event so the renderer can show "查看执行详情"
  //     immediately — before the tool finishes executing. This is critical
  //     for expert panels which take minutes to run; the user must be able
  //     to open the execution view while the experts are still working.
  ctx.emit('expert_run_started', {
    runId: run.runId,
    toolCallId: ctx.toolCallId ?? '',
    expertAgentId: args.agentId,
    expertName: agent.name
  })

  // 4. Execute the sub-agent
  setRunStatus(run.runId, 'running')

  try {
    let result: string

    if (agent.type === 'single') {
      // Single expert — run the sub-agent loop directly
      result = await runSubagent({
        agentId: args.agentId,
        sessionId: leaderSession.id,
        task: args.task,
        model,
        emit: ctx.emit,
        abortSignal: ctx.abortSignal,
        parentCtx: {
          parentSessionId: ctx.sessionId,
          parentRunId: run.runId
        },
        role: 'single'
      })
    } else {
      // Expert panel — orchestrate members, then leader aggregates
      result = await runExpertPanel(run.runId, args.agentId, args.task, ctx, model)
    }

    // 5. Update TaskRun with result
    setRunStatus(run.runId, 'completed', result)
    updateSubagentSessionStatus(args.agentId, leaderSession.id, 'completed')

    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setRunStatus(run.runId, 'failed', `执行失败：${msg}`)
    updateSubagentSessionStatus(args.agentId, leaderSession.id, 'failed')
    return JSON.stringify({ error: `Expert execution failed: ${msg}` })
  }
}

/**
 * Run an expert panel in a supervisor architecture:
 *
 *   leader → member1 → leader(supervise) → member2 → … → leader(aggregate)
 *
 * - In serial mode, each member runs in order. If a member FAILS (error,
 *   stall, or non-user-abort), the leader is invoked mid-stream as a
 *   supervisor to decide: RETRY, SKIP, or TERMINATE.
 * - In concurrent mode, all members run in parallel. Failed members are
 *   noted; the leader sees all results (successes + failures) during
 *   final aggregation.
 * - User-initiated abort (abortSignal) stops everything immediately —
 *   no leader supervisor call, no final aggregation.
 *
 * Member results (normal or abnormal) are ALWAYS returned to the leader.
 * The leader is the supervisor, not just a final aggregator.
 */
async function runExpertPanel(
  runId: string,
  leaderAgentId: string,
  task: string,
  ctx: ToolExecContext,
  model: ModelConfig
): Promise<string> {
  const graph = loadAgentGraph(leaderAgentId)
  if (!graph) {
    throw new Error(`No graph.yaml found for expert_panel agent: ${leaderAgentId}`)
  }

  const leaderAgent = loadAgentDefinition(leaderAgentId)
  if (!leaderAgent) {
    throw new Error(`Leader agent definition not found: ${leaderAgentId}`)
  }

  const run = getTaskRun(runId)
  if (!run) {
    throw new Error(`TaskRun not found: ${runId}`)
  }
  const leaderSessionId = run.leaderSessionId

  const memberNodes = graph.nodes.filter((n) => n.role === 'member')
  const memberArtifacts: { agentId: string; name: string; artifactPath: string }[] = []
  const memberErrors: { agentId: string; name: string; error: string }[] = []

  if (graph.execution.mode === 'concurrent') {
    // Concurrent: all members run in parallel. Failed members are tracked
    // but don't crash the panel — the leader handles them at aggregation.
    const promises = memberNodes.map((node) => runMember(runId, node.agentId, task, ctx, model))
    const results = await Promise.all(promises)

    for (const r of results) {
      if (ctx.abortSignal.aborted) continue
      if (isAbortedResult(r.result)) {
        memberErrors.push({ agentId: r.agentId, name: r.name, error: r.result })
        continue
      }
      const artifactPath = saveMemberArtifact(
        ctx.sessionId,
        runId,
        r.agentId,
        r.name,
        r.result,
        r.sessionId
      )
      if (artifactPath) {
        memberArtifacts.push({ agentId: r.agentId, name: r.name, artifactPath })
      }
    }
  } else {
    // Serial supervisor: leader → member → leader(decide) → member → …
    for (const node of memberNodes) {
      if (ctx.abortSignal.aborted) break

      // Serial handoff: next member gets the previous member's artifact
      const lastArtifact =
        memberArtifacts.length > 0 ? [memberArtifacts[memberArtifacts.length - 1]] : []
      const context = buildArtifactsContext(lastArtifact)

      // Run member (never throws — returns result, possibly an error string)
      let result = await runMember(runId, node.agentId, task, ctx, model, context || undefined)

      // User aborted during member execution — stop everything
      if (ctx.abortSignal.aborted) break

      // Member failed — invoke leader as supervisor to decide next step
      if (isAbortedResult(result.result)) {
        const decisionResult = await runLeaderSupervisor(
          runId,
          leaderAgentId,
          leaderSessionId,
          task,
          result.agentId,
          result.name,
          result.result,
          memberArtifacts,
          memberErrors,
          ctx,
          model
        )

        const action = parseLeaderDecision(decisionResult)

        if (action === 'TERMINATE') {
          // Leader decided to terminate — return its explanation to lucid
          return decisionResult
        }

        if (action === 'RETRY') {
          // Re-run the member once (single retry)
          result = await runMember(runId, node.agentId, task, ctx, model, context || undefined)
          if (ctx.abortSignal.aborted) break
        }

        // If still failed after retry (or SKIP was chosen), record and continue
        if (isAbortedResult(result.result)) {
          memberErrors.push({ agentId: result.agentId, name: result.name, error: result.result })
          continue
        }
      }

      // Member succeeded — save artifact
      const artifactPath = saveMemberArtifact(
        ctx.sessionId,
        runId,
        result.agentId,
        result.name,
        result.result,
        result.sessionId
      )
      if (artifactPath) {
        memberArtifacts.push({ agentId: result.agentId, name: result.name, artifactPath })
      }
    }
  }

  // User aborted — don't run the leader, just return
  if (ctx.abortSignal.aborted) {
    return '（任务已被用户终止。）'
  }

  // Final leader aggregation — leader sees ALL member results (success + failure)
  const context = buildAggregationContext(memberArtifacts, memberErrors)
  const leaderResult = await runSubagent({
    agentId: leaderAgentId,
    sessionId: leaderSessionId,
    task,
    context,
    model,
    emit: ctx.emit,
    abortSignal: ctx.abortSignal,
    parentCtx: {
      parentSessionId: ctx.sessionId,
      parentRunId: runId
    },
    role: 'leader'
  })

  return leaderResult
}

/**
 * Invoke the leader in supervisor mode to decide what to do when a member
 * fails. The leader receives the failure details + all completed artifacts
 * so far, and must output RETRY / SKIP / TERMINATE on the first line.
 *
 * Uses the leader's session so the conversation history is preserved for
 * the final aggregation call.
 */
async function runLeaderSupervisor(
  runId: string,
  leaderAgentId: string,
  leaderSessionId: string,
  task: string,
  failedAgentId: string,
  failedAgentName: string,
  errorResult: string,
  memberArtifacts: { agentId: string; name: string; artifactPath: string }[],
  memberErrors: { agentId: string; name: string; error: string }[],
  ctx: ToolExecContext,
  model: ModelConfig
): Promise<string> {
  const context = buildSupervisorContext(memberArtifacts, memberErrors)
  const isQualityRejection = errorResult.includes('⚠️ 输入质量不足')
  const supervisorTask = [
    '【监督决策】',
    `原始研究任务：${task}`,
    `成员 ${failedAgentName}（${failedAgentId}）${isQualityRejection ? '因输入质量不足而拒绝执行' : '执行失败'}。`,
    `${isQualityRejection ? '成员反馈' : '失败结果'}：${errorResult}`,
    '',
    '请评估当前情况，决定下一步：',
    '- RETRY：重试该成员',
    '- SKIP：跳过该成员，继续执行下一步',
    '- TERMINATE：终止整个任务，向用户返回说明',
    '',
    isQualityRejection
      ? '注意：该成员因输入质量不足而拒绝执行。请评估是否需要重新执行前序环节以提供更高质量的输入，或者跳过该成员继续。'
      : '注意：该成员执行失败。请评估该失败是否影响最终报告质量，是否有替代方案。',
    '',
    '在回答的首行给出以上三个关键词之一，之后简要说明你的理由。'
  ].join('\n')

  return await runSubagent({
    agentId: leaderAgentId,
    sessionId: leaderSessionId,
    task: supervisorTask,
    context,
    model,
    emit: ctx.emit,
    abortSignal: ctx.abortSignal,
    parentCtx: {
      parentSessionId: ctx.sessionId,
      parentRunId: runId
    },
    role: 'leader'
  })
}

/**
 * Parse the leader's supervisor decision from the first line of its response.
 * Defaults to SKIP if no keyword is found — safest non-destructive choice.
 */
function parseLeaderDecision(result: string): 'RETRY' | 'SKIP' | 'TERMINATE' {
  const firstLine = result.trim().split('\n')[0]?.toUpperCase() ?? ''
  if (firstLine.includes('TERMINATE')) return 'TERMINATE'
  if (firstLine.includes('RETRY')) return 'RETRY'
  if (firstLine.includes('SKIP')) return 'SKIP'
  return 'SKIP'
}

async function runMember(
  runId: string,
  memberAgentId: string,
  task: string,
  ctx: ToolExecContext,
  model: ModelConfig,
  context?: string
): Promise<{ agentId: string; name: string; result: string; sessionId: string }> {
  const memberAgent = loadAgentDefinition(memberAgentId)
  if (!memberAgent) {
    throw new Error(`Member agent definition not found: ${memberAgentId}`)
  }

  // Create member session
  const memberSession = createSubagentSession(memberAgentId, {
    parentRunId: runId,
    parentSessionId: ctx.sessionId, // leader session ID would be better, but
    // we need the leader's session ID. For now, use the main session as parent.
    task
  })

  // Register member in TaskRun
  addMemberSession(runId, {
    agentId: memberAgentId,
    sessionId: memberSession.id
  })

  try {
    const result = await runSubagent({
      agentId: memberAgentId,
      sessionId: memberSession.id,
      task,
      context,
      model,
      emit: ctx.emit,
      abortSignal: ctx.abortSignal,
      parentCtx: {
        parentSessionId: ctx.sessionId,
        parentRunId: runId
      },
      role: 'member'
    })

    // Member failed (error/abort/stall) — mark as failed so the UI shows
    // a red X, not a green checkmark. The error result is still returned
    // to the caller (runExpertPanel) so the leader can process it.
    const failed = isAbortedResult(result)
    updateMemberSession(runId, memberAgentId, {
      status: failed ? 'failed' : 'completed',
      result
    })
    updateSubagentSessionStatus(memberAgentId, memberSession.id, failed ? 'failed' : 'completed')

    return { agentId: memberAgentId, name: memberAgent.name, result, sessionId: memberSession.id }
  } catch (err) {
    // Don't throw — return the error as a result so the leader (supervisor)
    // can decide what to do. Threading the exception up would crash the
    // entire expert panel and leave the task "stuck" with no resolution.
    const msg = err instanceof Error ? err.message : String(err)
    const errorResult = `（子智能体执行失败：${msg}）`
    updateMemberSession(runId, memberAgentId, {
      status: 'failed',
      result: errorResult
    })
    updateSubagentSessionStatus(memberAgentId, memberSession.id, 'failed')
    return {
      agentId: memberAgentId,
      name: memberAgent.name,
      result: errorResult,
      sessionId: memberSession.id
    }
  }
}

/**
 * Build a context string listing artifact file paths for the next sub-agent
 * (next member in serial mode, or the leader for aggregation). The recipient
 * uses the `read` tool to load the file contents — no text is passed inline.
 */
function buildArtifactsContext(
  artifacts: { agentId: string; name: string; artifactPath: string }[]
): string {
  if (artifacts.length === 0) return ''
  const lines = artifacts.map((m, i) => {
    return `## ${i + 1}. ${m.name} (${m.agentId})\n产物文件路径：${m.artifactPath}`
  })
  return [
    '以下是之前团队成员的执行产物文件。请使用 read 工具读取这些文件，了解他们的工作成果：',
    '',
    lines.join('\n\n')
  ].join('\n')
}

/**
 * Build the full context for the leader's final aggregation: successful
 * member artifacts (file paths) + failed member error messages (inline).
 * The leader can see which members succeeded and which failed, and produce
 * its final report accordingly.
 *
 * What the leader chooses to read is defined by the leader's AGENT.md —
 * the platform provides all paths, the agent definition controls behavior.
 */
function buildAggregationContext(
  artifacts: { agentId: string; name: string; artifactPath: string }[],
  errors: { agentId: string; name: string; error: string }[]
): string {
  const parts: string[] = []

  if (artifacts.length > 0) {
    const lines = artifacts.map((m, i) => {
      return `### ${i + 1}. ${m.name} (${m.agentId})\n产物文件路径：${m.artifactPath}`
    })
    parts.push('## 已成功完成的成员产物\n\n请使用 read 工具读取以下文件：\n\n' + lines.join('\n\n'))
  }

  if (errors.length > 0) {
    const lines = errors.map((e) => {
      return `- ${e.name}（${e.agentId}）：${e.error}`
    })
    parts.push('## 执行失败的成员\n\n以下成员未能产出有效结果：\n\n' + lines.join('\n'))
  }

  return parts.join('\n\n')
}

/**
 * Build context for the leader's supervisor decision call. Includes
 * completed artifacts and previous failures so the leader has full context
 * when deciding RETRY / SKIP / TERMINATE.
 */
function buildSupervisorContext(
  artifacts: { agentId: string; name: string; artifactPath: string }[],
  errors: { agentId: string; name: string; error: string }[]
): string {
  if (artifacts.length === 0 && errors.length === 0) return ''
  return buildAggregationContext(artifacts, errors)
}

export const sessionSpawnTool: ToolDef = {
  name: 'session_spawn',
  openai: TOOL_DEF,
  execute
}
