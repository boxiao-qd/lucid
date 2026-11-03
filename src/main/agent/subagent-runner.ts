// Sub-agent runner — a purpose-built agent loop for sub-agents (experts).
//
// Simpler than runAgent: no memory, no skill catalog, no steer, no context
// compaction. Uses the AGENT.md system prompt, three-layer-filtered tools,
// and writes to the sub-agent session JSONL via appendSubagentSessionMessage.
//
// Every emitted event is tagged with agentId + runId so the frontend can route
// it to the correct node in the execution view.

import { randomUUID } from 'node:crypto'
import type { ModelConfig } from '../../shared/types'
import type { AgentDefinitionFull } from '../../shared/subagent-types'
import type { Emit } from './event-bus'
import type { PlanStep } from '../../shared/agent-events'
import { getOrCreateClient, streamChat, type LlmMessage } from './llm-client'
import { registerTools, executeTool } from './tool-registry'
import { appendSubagentSessionMessage } from '../subagent/subagent-sessions'
import { loadSubagentConfig } from '../subagent/subagent-config'
import type { ToolDef, OpenAIToolDef } from './tool-def'

const SUBAGENT_MAX_STALLS = 3

export interface RunSubagentArgs {
  agentId: string
  /** Sub-agent session ID (from createSubagentSession). */
  sessionId: string
  /** Task description — injected as the initial user message. */
  task: string
  /** Additional context (e.g. member results for leader aggregation). */
  context?: string
  model: ModelConfig
  emit: Emit
  abortSignal: AbortSignal
  parentCtx: {
    parentSessionId: string
    parentRunId: string
  }
  /**
   * Role of this sub-agent in the execution. Members of an expert_panel are
   * denied `save_product` — their results are passed to the leader via
   * saveMemberArtifact, not saved directly to the user's product directory.
   * Only the leader (or single experts) can call save_product.
   */
  role?: 'leader' | 'member' | 'single'
}

/**
 * Build the sub-agent system prompt: AGENT.md body + minimal platform/time
 * info + available tool list.
 */
function buildSubagentSystemPrompt(
  agent: AgentDefinitionFull,
  toolNames: string[],
  parentRunId: string
): string {
  const isWin = process.platform === 'win32'
  const langHeader = `[语言要求 — 强制]
你的所有输出必须使用中文，包括思考过程（reasoning/thinking）、工具参数和最终回答。`

  const timeHeader = `[当前时间] ${new Date().toLocaleString('zh-CN')}`

  const platformSection = `[当前平台]
操作系统：${isWin ? 'Windows (win32)' : process.platform === 'darwin' ? 'macOS (darwin)' : 'Linux (' + process.platform + ')'}
工作目录：~/.lucid/workspace/`

  const toolsSection = `[可用工具]
${toolNames.map((n) => `- ${n}`).join('\n')}`

  const runInfo = `[执行上下文]
子智能体 ID：${agent.agentId}
任务执行记录 ID：${parentRunId}
你不能调用 session_spawn 工具（禁止嵌套委派）。`

  return [
    langHeader,
    timeHeader,
    platformSection,
    toolsSection,
    runInfo,
    '---',
    agent.systemPrompt
  ].join('\n\n')
}

/**
 * Three-layer tool filtering:
 *   L1: global deny (config.json)
 *   L2: agent deny (AGENT.md tools.deny)
 *   L3: agent allow (AGENT.md tools.allow, "*" = all)
 *   Plus: session_spawn always denied.
 *   Plus: save_product denied for expert_panel members — their results are
 *   passed to the leader via saveMemberArtifact, not saved to the user's
 *   product directory. Only the leader or single experts can save products.
 */
function filterSubagentTools(
  allByName: Map<string, ToolDef>,
  agent: AgentDefinitionFull,
  role: 'leader' | 'member' | 'single'
): { byName: Map<string, ToolDef>; openaiDefs: OpenAIToolDef[] } {
  const config = loadSubagentConfig()
  const globalDeny = new Set<string>([
    ...config.globalTools.deny,
    // Always deny session_spawn for sub-agents — no nesting.
    'session_spawn'
  ])
  // Members of an expert_panel cannot save products directly — only the
  // leader aggregates and saves the final deliverable.
  if (role === 'member') {
    globalDeny.add('save_product')
  }
  const agentDeny = new Set<string>(agent.tools?.deny ?? [])
  const agentAllow = agent.tools?.allow

  // Start with all tool names
  let allowedNames: Set<string>
  if (!agentAllow || (agentAllow.length === 1 && agentAllow[0] === '*')) {
    // "*" or unspecified = all tools
    allowedNames = new Set(allByName.keys())
  } else {
    allowedNames = new Set(agentAllow)
  }

  // Apply deny layers (deny always wins)
  for (const name of globalDeny) allowedNames.delete(name)
  for (const name of agentDeny) allowedNames.delete(name)

  // Build filtered maps
  const filteredByName = new Map<string, ToolDef>()
  const filteredDefs: OpenAIToolDef[] = []
  for (const name of allowedNames) {
    const t = allByName.get(name)
    if (t) {
      filteredByName.set(name, t)
      filteredDefs.push(t.openai)
    }
  }
  return { byName: filteredByName, openaiDefs: filteredDefs }
}

/**
 * Wrap the parent emit so every event from this sub-agent carries agentId +
 * runId, letting the frontend route events to the right execution node.
 */
function tagEmit(
  parentEmit: Emit,
  agentId: string,
  runId: string,
  role: 'leader' | 'member' | 'single'
): Emit {
  return (type, data) => {
    parentEmit(type, { ...data, agentId, runId, subagentRole: role })
  }
}

/**
 * Run a sub-agent's agent loop. Returns the final text answer.
 *
 * For `single` experts: called once with the user's task.
 * For `expert_panel` leaders: called after all members finish, with member
 *   results injected as context for aggregation.
 * For `expert_panel` members: called with the leader-delegated subtask.
 */
export async function runSubagent(args: RunSubagentArgs): Promise<string> {
  const { agentId, sessionId, task, context, model, emit, abortSignal, parentCtx } = args

  // Load agent definition
  const { loadAgentDefinition } = await import('../subagent/agent-definition')
  const agent = loadAgentDefinition(agentId)
  if (!agent) {
    throw new Error(`Sub-agent definition not found: ${agentId}`)
  }

  // Determine role: explicit param > inference from agent.type
  const role: 'leader' | 'member' | 'single' =
    args.role ?? (agent.type === 'expert_panel' ? 'leader' : 'single')
  const taggedEmit = tagEmit(emit, agentId, parentCtx.parentRunId, role)

  // Wrap emit to persist plan events to the sub-agent session JSONL —
  // same pattern as agent-runner.ts wrappedEmit. Without this, plan
  // data (from TodoWrite) is never stored in the session, so the
  // SessionMessageView in ExecutionView has nothing to render.
  const subagentEmit: Emit = (type, data) => {
    taggedEmit(type, data)
    switch (type) {
      case 'plan_created':
      case 'plan_adjusted': {
        const d = data as { steps: PlanStep[] }
        if (d.steps?.length) {
          appendSubagentSessionMessage(
            agentId,
            sessionId,
            'assistant',
            JSON.stringify(d.steps),
            'plan'
          )
        }
        break
      }
    }
  }

  // Register all tools, then filter
  const { byName: allByName } = registerTools()
  const { byName, openaiDefs } = filterSubagentTools(allByName, agent, role)

  // Build system prompt
  const toolNames = openaiDefs.map((d) => d.function.name)
  const systemPrompt = buildSubagentSystemPrompt(agent, toolNames, parentCtx.parentRunId)

  // Build the user message (task + optional context)
  const userMessage = context ? `${task}\n\n---\n${context}` : task

  // Persist the user message in the sub-agent session
  appendSubagentSessionMessage(agentId, sessionId, 'user', userMessage, 'text')

  const assistantMsgId = randomUUID()
  subagentEmit('stream_start', { message_id: assistantMsgId })

  const llmMessages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ]

  let finalText: string | null = null
  let emptyTurnCount = 0

  try {
    for (;;) {
      if (abortSignal.aborted) {
        finalText = '（子智能体任务已被取消。）'
        break
      }

      let currentContent = ''
      let reasoningContent = ''
      let thinkingStarted = false

      let stream: {
        toolCalls: { id: string; name: string; arguments: string }[]
        totalTokens: number
      }
      try {
        stream = await streamChat(
          getOrCreateClient(model),
          model,
          llmMessages,
          openaiDefs,
          abortSignal,
          {
            onReasoning: (delta) => {
              reasoningContent += delta
              if (!thinkingStarted) {
                subagentEmit('thinking_start', { message_id: assistantMsgId, delta: '' })
                thinkingStarted = true
              }
              subagentEmit('thinking_delta', { message_id: assistantMsgId, delta })
            },
            onText: (delta) => {
              currentContent += delta
              subagentEmit('text_delta', { message_id: assistantMsgId, delta })
            },
            onToolCallStart: (id, name) => {
              subagentEmit('tool_call_start', {
                tool_call_id: id,
                tool_name: name,
                args_preview: ''
              })
            },
            onToolCallDelta: (id, argsDelta, partialArgs) => {
              subagentEmit('tool_call_delta', {
                tool_call_id: id,
                args_delta: argsDelta,
                partial_args: partialArgs
              })
            }
          },
          undefined // no steer for sub-agents
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        finalText = `（子智能体执行失败：${msg}）`
        break
      }

      if (thinkingStarted) {
        subagentEmit('thinking_end', { message_id: assistantMsgId })
      }

      // Persist reasoning if present
      if (reasoningContent.trim()) {
        appendSubagentSessionMessage(agentId, sessionId, 'assistant', reasoningContent, 'thinking')
      }

      const toolCalls = stream.toolCalls.filter((tc) => tc.id && tc.name)

      if (toolCalls.length > 0) {
        emptyTurnCount = 0

        // Persist intermediate text content — the LLM may output structured
        // content (sub-questions, research findings, analysis) as text BEFORE
        // calling tools. Without this, only the final text answer is saved
        // to the session, and intermediate outputs are lost.
        if (currentContent.trim()) {
          appendSubagentSessionMessage(agentId, sessionId, 'assistant', currentContent, 'text')
        }

        // Emit + persist tool_call entries
        for (const tc of toolCalls) {
          subagentEmit('tool_call_end', {
            tool_call_id: tc.id,
            tool_name: tc.name,
            args: tc.arguments
          })
          appendSubagentSessionMessage(agentId, sessionId, 'assistant', tc.arguments, 'tool_call', {
            toolCallId: tc.id,
            toolName: tc.name
          })
        }

        // Execute each tool
        const results: { id: string; name: string; result: string }[] = []
        for (const tc of toolCalls) {
          const ctx = {
            sessionId,
            emit: subagentEmit,
            abortSignal,
            toolCallId: tc.id,
            parentSessionId: parentCtx.parentSessionId,
            runId: parentCtx.parentRunId
          }
          const result = await executeTool(tc.name, tc.arguments, ctx, byName)
          const isError = result.startsWith('{"error":')
          subagentEmit('tool_result', {
            tool_call_id: tc.id,
            tool_name: tc.name,
            result,
            is_error: isError
          })
          appendSubagentSessionMessage(agentId, sessionId, 'user', result, 'tool_result', {
            toolCallId: tc.id,
            toolName: tc.name,
            isError
          })
          results.push({ id: tc.id, name: tc.name, result })
        }

        // Append to LLM message history
        llmMessages.push({
          role: 'assistant',
          content: currentContent,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
        })
        for (const r of results) {
          let inline = r.result
          // read tool returns workspace artifact file content (up to 256KB).
          // In the deep research pipeline, agents read the previous agent's
          // artifact via read — truncating to 8000 chars loses most of the
          // content and causes detail loss in the final report. Allow read
          // results up to 50000 chars; keep 8000 for everything else.
          const cap = r.name === 'read' ? 50000 : 8000
          if (inline.length > cap) {
            inline = inline.slice(0, cap) + '\n…[内容过长已截断]'
          }
          llmMessages.push({ role: 'tool', tool_call_id: r.id, content: inline })
        }
        continue
      }

      // No tool calls — check for final answer
      const finalContent = currentContent.trim()
      if (finalContent) {
        finalText = finalContent
        break
      }

      // Stall
      emptyTurnCount++
      if (emptyTurnCount > SUBAGENT_MAX_STALLS) {
        finalText = finalContent || '（子智能体多次未给出有效回答。）'
        break
      }

      // Nudge
      llmMessages.push({
        role: 'user',
        content:
          '你刚才没有给出最终回答或调用工具。请直接给出完整的文字回答，或者调用合适的工具继续完成任务。'
      })
    }
  } finally {
    // Persist the final text answer
    const text = finalText ?? '（子智能体执行异常终止。）'
    const finalMsg = appendSubagentSessionMessage(agentId, sessionId, 'assistant', text, 'text')
    subagentEmit('message_done', {
      message_id: finalMsg.id,
      streaming_message_id: assistantMsgId,
      content: finalText,
      role: 'assistant',
      token_count: 0,
      stop_reason: 'stop'
    })
  }

  return finalText
}
