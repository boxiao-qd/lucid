// Agent runner — the main agent loop that processes messages and calls tools.
//
// Persistence strategy: messages (thinking, plan, tool_call, tool_result)
// are persisted to JSONL INCREMENTALLY during the run — not batched at the end.
// This ensures that switching sessions mid-run preserves tool call records
// and the "查看执行详情" entry. tool_call is persisted AFTER tool execution
// so the expert ref from session_spawn can be attached.

import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelConfig, Message, MessageType } from '../../shared/types'
import type { PlanStep } from '../../shared/agent-events'
import type { Emit } from './event-bus'
import {
  getOrCreateClient,
  streamChat,
  ContextOverflowError,
  type LlmMessage,
  type ToolCallAccum
} from './llm-client'
import { buildSystemPrompt, injectTodoProgress } from './system-prompt'
import { registerTools, filterToolDefs, executeTool } from './tool-registry'
import type { ToolExecContext } from './tool-def'
import { forceCompleteTodos, getAllCompleted, clearTodos, getTodos } from './todo-store'
import { appendSessionMessage } from '../sessions'
import { loadSkillBySlug, skillPromptPath } from '../skills'
import { getMcpTools } from '../mcp/mcp-runtime'
import { extractMemoriesDirect } from '../memory/memory-extract'
import { startTurn, addEvent, endTurn } from './trace-store'
import { setActiveModelForSubagent } from './tools/session-spawn'

// Minimal XML escaper for skill catalog injection
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Recursively expand a path into individual file paths.
// If the path is a file, returns [path].
// If the path is a directory, recursively lists all files inside (including
// nested directories) and returns them as a flat array — directories themselves
// are not included in the result.
// If stat fails (non-existent / inaccessible / not a regular file or dir),
// returns [] — the path is silently skipped so non-existent entries (e.g.
// deleted files in write_paths) don't pollute the product list.
function expandFilePath(filePath: string): string[] {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(filePath)
  } catch {
    return []
  }
  if (stats.isFile()) return [filePath]
  if (!stats.isDirectory()) return []
  const out: string[] = []
  for (const entry of readdirSync(filePath)) {
    if (entry.startsWith('.')) continue // skip hidden entries
    const child = join(filePath, entry)
    out.push(...expandFilePath(child))
  }
  return out
}

// Extract file paths from tool call arguments for tools that don't return
// file_path in their result (code_execute, terminal). These tools declare
// written paths via a `write_paths` array in their arguments.
function extractWritePathsFromArgs(toolName: string, args: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(args) as unknown
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>
  const raw: unknown[] = []
  if (toolName === 'code_execute') {
    // { ..., write_paths: ["path1", "path2"] }
    if (Array.isArray(obj.write_paths)) raw.push(...obj.write_paths)
  } else if (toolName === 'terminal') {
    // Top-level write_paths (single-command mode)
    if (Array.isArray(obj.write_paths)) raw.push(...obj.write_paths)
    // Sub-commands array (each has its own write_paths)
    if (Array.isArray(obj.commands)) {
      for (const cmd of obj.commands) {
        if (
          cmd &&
          typeof cmd === 'object' &&
          Array.isArray((cmd as Record<string, unknown>).write_paths)
        ) {
          raw.push(...((cmd as Record<string, unknown>).write_paths as unknown[]))
        }
      }
    }
  }
  return raw.filter((p): p is string => typeof p === 'string' && p.length > 0)
}

// Cap message history to the last N rounds (N user + N assistant messages).
// A "round" is one user message followed by one assistant message. This
// function walks backwards through the array, collecting up to N of each
// role, then returns the collected messages in original order.
function capToLastRounds(messages: Message[], rounds: number): Message[] {
  const result: Message[] = []
  let userCount = 0
  let assistantCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && userCount < rounds) {
      result.unshift(msg)
      userCount++
    } else if (msg.role === 'assistant' && assistantCount < rounds) {
      result.unshift(msg)
      assistantCount++
    }
    if (userCount >= rounds && assistantCount >= rounds) break
  }
  return result
}

// Extract a short preview of what triggered this LLM call (the last
// non-system message in llmMessages). For iteration 0, this is the user's
// question. For subsequent iterations, this is the tool results from the
// previous iteration.
function extractInputPreview(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : ''
      return content.slice(0, 80).trim()
    }

    if (msg.role === 'tool') {
      // Count consecutive tool results and find the preceding assistant
      // message with tool_calls to get the tool names
      let toolResultCount = 0
      for (let j = i; j >= 0; j--) {
        if (messages[j].role === 'tool') {
          toolResultCount++
        } else if (messages[j].role === 'assistant' && messages[j].tool_calls) {
          const names = messages[j].tool_calls!.map((tc) => tc.function.name)
          return `工具结果×${toolResultCount} [${names.join(', ')}]`
        } else {
          break
        }
      }
      return `工具结果×${toolResultCount}`
    }

    if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content : ''
      return content.slice(0, 80).trim()
    }
  }
  return ''
}

// Build a short preview of what the LLM produced in this call.
// Structured but truncated — full content lives in the session messages,
// trace only needs enough to identify what happened.
function buildOutputPreview(
  reasoning: string,
  text: string,
  toolCalls: { id: string; name: string; arguments: string }[]
): { reasoning: string | null; text: string | null; tool_calls: string[] } {
  return {
    reasoning: reasoning.slice(0, 200).trim() || null,
    text: text.slice(0, 200).trim() || null,
    tool_calls: toolCalls.length > 0 ? toolCalls.map((tc) => tc.name) : []
  }
}

const MAX_ITERATIONS = 80
const TOOL_RESULT_INLINE_CAP = 8000
// session_spawn (expert panel) returns the leader's full research report —
// capping it at 8000 chars would lose detail. Use a higher limit so the
// main agent can present the expert's work without truncation.
const SESSION_SPAWN_RESULT_CAP = 50000
// How many consecutive stalls (no tool call + no final answer) before giving up.
// Complex tasks (PPT, code with quality-check loops) may stall while the LLM
// reasons about how to fix an issue — give it room to recover.
const MAX_STALLS = 5

export interface RunAgentArgs {
  sessionId: string
  userMessage: string
  attachments?: string[]
  model: ModelConfig
  history: Message[]
  emit: Emit
  abortSignal: AbortSignal
  steerQueue?: string[]
  skillSlug?: string
  expertAgentId?: string
}

export async function runAgent(args: RunAgentArgs): Promise<void> {
  const {
    sessionId,
    userMessage,
    attachments,
    model,
    history,
    emit,
    abortSignal,
    steerQueue,
    skillSlug,
    expertAgentId
  } = args

  // ── Trace: start a new turn for behavior analysis ──
  const turnStart = Date.now()
  const turnId = startTurn(sessionId, userMessage)
  addEvent(turnId, '收到请求', { message_preview: userMessage.slice(0, 100) })

  // Persist state — tracks reasoning content across callbacks for thinking_end collection
  const persistState = { reasoningContent: '' }

  // Track whether session_spawn has been called — when an expert is selected,
  // we must not accept a text-only answer until the expert has been delegated.
  let expertDelegated = false

  // Persistence: messages are written to JSONL incrementally during the run
  // so that switching sessions mid-run preserves tool call records. thinking
  // and plan are persisted here in wrappedEmit; tool_call and tool_result are
  // persisted in the execution loop below (after tool execution, so the
  // expert ref from session_spawn can be attached to the tool_call message).
  const wrappedEmit: Emit = (type, data) => {
    emit(type, data)

    // Sub-agent events are tagged with agentId by tagEmit. They must NOT be
    // persisted to the main session — they belong to the sub-agent's own
    // session JSONL (handled by subagentEmit in subagent-runner.ts).
    const isSubagentEvent = typeof (data as { agentId?: unknown })?.agentId === 'string'

    switch (type) {
      case 'thinking_end':
        if (!isSubagentEvent && persistState.reasoningContent.trim()) {
          appendSessionMessage(sessionId, 'assistant', persistState.reasoningContent, 'thinking')
        }
        break
      case 'plan_created':
      case 'plan_adjusted': {
        if (isSubagentEvent) break
        const d = data as { steps: PlanStep[] }
        if (d.steps?.length) {
          appendSessionMessage(sessionId, 'assistant', JSON.stringify(d.steps), 'plan')
        }
        break
      }
      // tool_call_end and tool_result are persisted in the execution loop
      // below (after tool execution, so the expert ref is available).
    }
  }

  // Emit stream_start + user_ack IMMEDIATELY — before any async work
  // (tool registration, memory context, skill loading).
  // The user must see "已接收到您的问题" the instant they submit, not after
  // 3 seconds of connection/setup overhead.
  // NOTE: MCP runtime is initialized once at app startup and read
  // synchronously below — no per-run spawn/handshake/listTools here.
  const assistantMsgId = randomUUID()
  wrappedEmit('stream_start', { message_id: assistantMsgId })
  wrappedEmit('user_ack', {
    message_id: assistantMsgId,
    message: '已接收到您的问题，正在分析处理中…'
  })

  // Reset todo state for this new user turn. Todos are session-scoped and
  // persist across iterations within a single turn, but a NEW user message
  // must not inherit the previous turn's "all completed" state — otherwise
  // getAllCompleted() returns true on iteration 0, the loop strips TodoWrite
  // and pushes "所有任务已完成，请直接回答", which blocks tool use and
  // produces the bogus "（所有任务已完成。）" fallback.
  clearTodos(sessionId)

  const client = getOrCreateClient(model)
  // Expose the active model to session_spawn so it can pass it to runSubagent.
  // Sub-agents inherit lucid's model — no separate model config in AGENT.md.
  setActiveModelForSubagent(model)
  const { byName, openaiDefs } = registerTools()

  // Read MCP tools from the global runtime (initialized at app startup).
  // This is a synchronous O(tools) read — never spawns a process. If MCP
  // init hasn't completed yet (rare race at app start), returns [] and the
  // agent runs without MCP tools for this turn.
  const mcpToolDefs = getMcpTools()
  for (const tool of mcpToolDefs) {
    byName.set(tool.name, tool)
    openaiDefs.push(tool.openai)
  }

  const basePrompt = buildSystemPrompt(
    openaiDefs.map((d) => d.function.name),
    sessionId
  )

  // Inject skill catalog into the system prompt.
  // The catalog lists the selected skill's name, description, and absolute
  // path to SKILL.md. The agent uses the `read` tool to load SKILL.md on
  // demand, and resolves relative paths against the skill directory for
  // any reference/ or script/ files mentioned in SKILL.md.
  let fullPrompt = basePrompt
  if (skillSlug) {
    const skill = loadSkillBySlug(skillSlug)
    if (skill) {
      const location = skillPromptPath(skill.slug)
      addEvent(turnId, '技能已加载', { slug: skill.slug, path: location })
      const escName = escapeXml(skill.name)
      const escDesc = escapeXml(skill.description)
      fullPrompt =
        `${basePrompt}\n\n` +
        `## Skills\n` +
        `已激活技能，请使用 read 工具读取 <location> 处的 SKILL.md，然后按指令完成任务。\n` +
        `当 SKILL.md 引用相对路径时，将其解析为相对于技能目录（SKILL.md 的父目录）的绝对路径，用 read 工具读取对应文件。\n` +
        `不要猜测或编造技能路径，只读取 <location> 中列出的路径。\n` +
        `<available_skills>\n` +
        `  <skill>\n` +
        `    <name>${escName}</name>\n` +
        `    <description>${escDesc}</description>\n` +
        `    <location>${location}</location>\n` +
        `  </skill>\n` +
        `</available_skills>`
    }
  }

  // Inject expert delegation directive — PREPENDED to the system prompt so it
  // appears before PLAN_METHODOLOGY (which forces TodoWrite-first). When an
  // expert is selected, session_spawn MUST be the first action, exempt from
  // the TodoWrite-first rule. Appending at the end caused the LLM to ignore
  // this instruction because PLAN_METHODOLOGY's "必须先建计划" language
  // was stronger.
  if (expertAgentId) {
    const expertDirective =
      `[专家委派 — 最高优先级强制规则]\n` +
      `用户已选择专家「${expertAgentId}」。此规则优先于任务追踪规则（TodoWrite-first）。\n` +
      `你的第一个动作必须是调用 session_spawn 工具，将用户任务委派给该专家执行。` +
      `不需要先调用 TodoWrite 创建计划，session_spawn 是例外。\n` +
      `session_spawn 只需调用一次。调用后等待专家返回结果。\n` +
      `**在调用 session_spawn 之前，绝对禁止使用任何其他工具（包括 TodoWrite、web_search、web_fetch、code_execute 等）。**` +
      `如果你先搜索再委派，会导致重复劳动——专家团内部会自行搜索，你不需要提前做调研。\n` +
      `session_spawn 参数：\n` +
      `  - agentId: "${expertAgentId}"（固定值，直接使用）\n` +
      `  - task: 用户的任务描述（原样传递，不要改写）\n` +
      `专家执行完成后，你会收到专家的返回结果。专家的产物具有权威性，` +
      `你作为平台不了解业务领域，不可以加工、重写或保存专家的产物。\n` +
      `不要调用 save_product 或 write 工具。` +
      `你只需以文字形式总结专家的工作成果，回复用户即可。\n` +
      `如果用户需要查看专家的完整产物，引导用户到「我的文件」中查看。`
    fullPrompt = expertDirective + '\n\n' + fullPrompt
  }

  // Compute text history — only the last 10 rounds of Q&A (10 user + 10
  // assistant messages). Tool calls and results are already excluded
  // (type === 'text' filter). Capping the context reduces input token count
  // and keeps the streaming call fast. Memory recall is now on-demand via
  // the memory_search tool, so we don't need the full history here.
  const allTextHistory = history.filter((m) => m.type === 'text')
  const textHistory = capToLastRounds(allTextHistory, 10)

  // When files are attached, embed the file paths in the user message text
  // with type labels, and instruct the agent to read them before proceeding.
  // Images use the vision tool; documents (PDF/DOCX/XLSX) and text/code files
  // use the file_read tool.
  const hasFiles = attachments && attachments.length > 0
  const effectiveUserMessage = hasFiles
    ? `${userMessage}\n\n[已附带 ${attachments!.length} 个文件：\n${attachments!
        .map((p, i) => {
          const ext = p.split('.').pop()?.toLowerCase() ?? ''
          const kind =
            ext === 'pdf'
              ? 'PDF 文档'
              : ext === 'docx'
                ? 'Word 文档'
                : ext === 'xlsx'
                  ? 'Excel 表格'
                  : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)
                    ? '图片'
                    : [
                          'txt',
                          'md',
                          'json',
                          'csv',
                          'log',
                          'ts',
                          'js',
                          'tsx',
                          'jsx',
                          'py',
                          'go',
                          'rs',
                          'java',
                          'html',
                          'css',
                          'xml',
                          'yml',
                          'yaml',
                          'sh',
                          'sql'
                        ].includes(ext)
                      ? '文本文件'
                      : '文件'
          return `${i + 1}. ${p} (${kind})`
        })
        .join(
          '\n'
        )}\n请先用工具读取文件内容（文档用 file_read 工具，图片用 vision 工具），再结合文件内容和任务进行综合分析与决策。]`
    : userMessage

  // Drop the current user message from textHistory (it's re-added below
  // as effectiveUserMessage to avoid a duplicate message).
  if (
    textHistory.length > 0 &&
    textHistory[textHistory.length - 1].role === 'user' &&
    textHistory[textHistory.length - 1].content === userMessage
  ) {
    textHistory.pop()
  }

  let llmMessages: LlmMessage[] = [
    { role: 'system', content: fullPrompt },
    // For messages with file attachments, inject the file paths into the
    // content so the LLM can reference them without re-searching the disk.
    // User uploads use [已附带 N 个文件：...], assistant products use
    // [本轮流产物文件：...]. The attachments are also stored as a separate
    // field in the session JSONL and rendered as visual blocks in the UI.
    ...textHistory.map((m) => {
      if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
        const fileList = m.attachments.map((p, i) => `${i + 1}. ${p}`).join('\n')
        return {
          role: 'user',
          content: `${m.content}\n\n[已附带 ${m.attachments.length} 个文件：\n${fileList}]`
        } as LlmMessage
      }
      if (m.role === 'assistant' && m.attachments && m.attachments.length > 0) {
        const unique = [...new Set(m.attachments)]
        const fileList = unique.map((p) => `- ${p}`).join('\n')
        return {
          role: 'assistant',
          content: `${m.content}\n\n[本轮流产物文件：\n${fileList}]`
        } as LlmMessage
      }
      return { role: m.role, content: m.content } as LlmMessage
    }),
    { role: 'user', content: effectiveUserMessage }
  ]

  let allTodosDone = false
  let forceFinalPrompted = false
  // Tracks consecutive "no tool call + no real text answer" stalls. When the
  // LLM emits only reasoning (or a fragment like "让我再搜一下…") without
  // calling a tool while todos are still pending, we nudge it instead of
  // treating that as a final answer. After 2 stalls we give up.
  let emptyTurnCount = 0
  const contextWindow = model.contextWindow ?? 0

  // Final state — captured at each return point, persisted in finally block
  let finalText: string | null = null
  let finalStopReason = 'stop'
  let finalTokenCount = 0
  let finalError: { code: string; message: string } | null = null
  const generatedFilePaths: string[] = []

  try {
    // Track first token at the turn level — only emit the trace event once
    // for the entire turn, even across multiple iterations. Per-iteration
    // first_token_ms is still tracked separately for the completion event.
    let turnFirstTokenEmitted = false

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      addEvent(turnId, '迭代开始', { iteration })

      // ── Cancel check ──
      if (abortSignal.aborted) {
        wrappedEmit('text_delta', { message_id: assistantMsgId, delta: '（任务已被取消。）' })
        finalText = '（任务已被取消。）'
        finalStopReason = 'cancelled'
        return
      }

      // ── Inject todo progress into system message ──
      llmMessages[0].content = injectTodoProgress(fullPrompt, sessionId)

      // ── Drop TodoWrite when all todos are done (prevent looping) ──
      let effectiveTools = openaiDefs
      if (getAllCompleted(sessionId)) {
        effectiveTools = filterToolDefs(openaiDefs, new Set(['TodoWrite']))
      }

      // ── Force final answer when approaching max iterations ──
      // Remove all tools so the LLM can only produce text, and prompt it
      // to wrap up. This prevents hitting MAX_ITERATIONS without a final answer.
      if (iteration >= MAX_ITERATIONS - 8) {
        effectiveTools = []
        if (!forceFinalPrompted) {
          forceFinalPrompted = true
          llmMessages.push({
            role: 'user',
            content:
              '已接近执行步骤上限，请根据已收集的信息，直接给出完整的最终回答，不要再调用任何工具。'
          })
        }
      }

      // ── LLM stream call ──
      let currentContent = ''
      let reasoningContent = ''
      persistState.reasoningContent = ''
      let thinkingStarted = false
      let totalTokens = 0

      let stream: { toolCalls: ToolCallAccum[]; totalTokens: number; steered: boolean }
      try {
        addEvent(turnId, 'LLM调用开始', {
          iteration,
          model: model.name,
          input_preview: extractInputPreview(llmMessages)
        })
        const llmT0 = Date.now()
        let firstTokenAt: number | null = null
        let producedReasoning = false
        let producedText = false
        const markFirstToken = (): void => {
          if (firstTokenAt === null) {
            firstTokenAt = Date.now()
            // Only emit the trace event once per turn (first token across all
            // iterations). Per-iteration first_token_ms is still recorded in
            // the "LLM调用完成" event data for debugging.
            if (!turnFirstTokenEmitted) {
              turnFirstTokenEmitted = true
              addEvent(turnId, '首token到达', {
                first_token_ms: firstTokenAt - llmT0
              })
            }
          }
        }
        stream = await streamChat(
          client,
          model,
          llmMessages,
          effectiveTools,
          abortSignal,
          {
            onReasoning: (delta) => {
              markFirstToken()
              producedReasoning = true
              reasoningContent += delta
              persistState.reasoningContent = reasoningContent
              if (!thinkingStarted) {
                wrappedEmit('thinking_start', { message_id: assistantMsgId, delta: '' })
                thinkingStarted = true
              }
              wrappedEmit('thinking_delta', { message_id: assistantMsgId, delta })
            },
            onText: (delta) => {
              markFirstToken()
              producedText = true
              currentContent += delta
              wrappedEmit('text_delta', { message_id: assistantMsgId, delta })
            },
            onToolCallStart: (id, name) => {
              markFirstToken()
              wrappedEmit('tool_call_start', {
                tool_call_id: id,
                tool_name: name,
                args_preview: ''
              })
            },
            onToolCallDelta: (id, argsDelta, partialArgs) => {
              wrappedEmit('tool_call_delta', {
                tool_call_id: id,
                args_delta: argsDelta,
                partial_args: partialArgs
              })
            },
            onUsage: (t) => {
              totalTokens = t
            }
          },
          steerQueue
        )
        const toolCallCount = stream.toolCalls.filter((tc) => tc.id && tc.name).length
        // Build 产出 summary — what the LLM actually produced
        const outputParts: string[] = []
        if (producedReasoning) outputParts.push('思考')
        if (producedText) outputParts.push(toolCallCount > 0 ? '文本' : '最终回答')
        if (toolCallCount > 0) outputParts.push(`工具调用×${toolCallCount}`)
        const outputSummary = outputParts.join('+') || '空'
        const validToolCalls = stream.toolCalls.filter((tc) => tc.id && tc.name)
        const outputPreview = buildOutputPreview(reasoningContent, currentContent, validToolCalls)
        addEvent(turnId, 'LLM调用完成', {
          iteration,
          durationMs: Date.now() - llmT0,
          first_token_ms: firstTokenAt !== null ? firstTokenAt - llmT0 : null,
          产出: outputSummary,
          output_preview: outputPreview,
          tokens: totalTokens,
          tool_call_count: toolCallCount
        })
      } catch (err) {
        if (err instanceof ContextOverflowError) {
          finalText = '（上下文超限，任务终止。）'
          finalStopReason = 'context_limit'
          finalError = {
            code: 'CONTEXT_OVERFLOW',
            message: '当前任务上下文已超出模型处理上限，无法继续。请简化任务或开启新对话后重试。'
          }
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        finalText = `（模型调用失败：${msg}）`
        finalStopReason = 'error'
        finalError = { code: 'LLM_ERROR', message: msg }
        return
      }

      // Close thinking if it was opened and stream ended inside non-think state
      if (thinkingStarted) {
        wrappedEmit('thinking_end', { message_id: assistantMsgId })
      }

      // ── Steer: user supplemented info mid-stream → inject and re-iterate ──
      if (stream.steered && steerQueue && steerQueue.length > 0) {
        const steerText = steerQueue.shift()!
        // Push assistant's partial content (if any) + steer as user message
        if (currentContent) {
          llmMessages.push({ role: 'assistant', content: currentContent })
        }
        llmMessages.push({
          role: 'user',
          content: `[用户补充信息] ${steerText}\n（请结合当前任务和此信息，判断是否需要调整当前 plan 和执行。）`
        })
        wrappedEmit('task_steered', {
          run_id: assistantMsgId,
          content_preview: steerText.slice(0, 100)
        })
        // Persist steer text immediately
        appendSessionMessage(sessionId, 'user', `[用户补充信息] ${steerText}`, 'text')
        // Reset accumulators for next iteration
        currentContent = ''
        reasoningContent = ''
        continue
      }

      const toolCalls = stream.toolCalls.filter((tc) => tc.id && tc.name)

      // ── Branch: tool calls present → execute and loop ──
      if (toolCalls.length > 0) {
        // LLM called a tool — it's making progress, reset the stall counter.
        emptyTurnCount = 0
        // Persist the LLM's narration text (produced before the tool call) as
        // a separate text message — so it appears in the session history and
        // survives page refresh. Without this, only the final answer text is
        // persisted; intermediate narration between tool calls would be lost.
        if (currentContent.trim()) {
          appendSessionMessage(sessionId, 'assistant', currentContent, 'text')
        }
        // Emit tool_call_end + persist tool_call BEFORE execution.
        // session_spawn persists its own tool_call (with expert ref) inside
        // execute(), so we skip it — UNLESS this is a repeat call (already
        // delegated), in which case we won't call executeTool and must
        // persist the tool_call here so it shows up in the session.
        for (const tc of toolCalls) {
          wrappedEmit('tool_call_end', {
            tool_call_id: tc.id,
            tool_name: tc.name,
            args: tc.arguments
          })
          const isBlockedRepeat = tc.name === 'session_spawn' && expertDelegated
          if (tc.name !== 'session_spawn' || isBlockedRepeat) {
            appendSessionMessage(sessionId, 'assistant', tc.arguments, 'tool_call', {
              toolCallId: tc.id,
              toolName: tc.name
            })
          }
        }

        // Execute each tool and emit result
        const results: { id: string; name: string; result: string }[] = []
        for (const tc of toolCalls) {
          addEvent(turnId, '工具执行开始', {
            tool_name: tc.name,
            args_preview: tc.arguments.slice(0, 100)
          })

          // Before expert delegation — block ALL tools except session_spawn.
          // The expert directive tells the LLM to call session_spawn first,
          // but the LLM may ignore the prompt and try to "help" by doing
          // its own research first (e.g. calling web_search before
          // delegating). This code-level gate prevents that — when an
          // expert is selected, session_spawn is the ONLY allowed tool
          // until delegation completes.
          if (expertAgentId && !expertDelegated && tc.name !== 'session_spawn') {
            addEvent(turnId, '工具执行跳过', {
              tool_name: tc.name,
              reason: 'expert_not_yet_delegated'
            })
            const result = JSON.stringify({
              error:
                `用户已选择专家「${expertAgentId}」，必须先调用 session_spawn ` +
                `将任务委派给专家，不可以使用 ${tc.name} 或任何其他工具。` +
                `请立即调用 session_spawn，参数为 ` +
                `{ "agentId": "${expertAgentId}", "task": "用户的原始任务描述" }。`
            })
            appendSessionMessage(sessionId, 'assistant', result, 'tool_result', {
              toolCallId: tc.id,
              toolName: tc.name,
              isError: true
            })
            wrappedEmit('tool_result', {
              tool_call_id: tc.id,
              tool_name: tc.name,
              result,
              is_error: true
            })
            results.push({ id: tc.id, name: tc.name, result })
            continue
          }

          // Block repeat session_spawn calls — the expert directive is
          // removed from the system prompt after the first call, but the
          // LLM may still try to re-issue it. Return an error instead of
          // executing the sub-agent again.
          if (tc.name === 'session_spawn' && expertDelegated) {
            addEvent(turnId, '工具执行跳过', { tool_name: tc.name, reason: 'already_delegated' })
            const result = JSON.stringify({
              error:
                '专家已经委派过了，不要重复调用 session_spawn。请基于专家返回的结果整理后回复用户。'
            })
            appendSessionMessage(sessionId, 'assistant', result, 'tool_result', {
              toolCallId: tc.id,
              toolName: tc.name,
              isError: true
            })
            wrappedEmit('tool_result', {
              tool_call_id: tc.id,
              tool_name: tc.name,
              result,
              is_error: true
            })
            results.push({ id: tc.id, name: tc.name, result })
            continue
          }

          // Block save_product and write calls after expert delegation —
          // the expert's product is authoritative. Lucid, as a platform
          // that doesn't understand the business domain, must not rewrite,
          // modify, or create new files based on the expert's output.
          if (expertDelegated && (tc.name === 'save_product' || tc.name === 'write')) {
            addEvent(turnId, '工具执行跳过', {
              tool_name: tc.name,
              reason: 'expert_product_protected'
            })
            const result = JSON.stringify({
              error:
                '专家已返回产物，产物具有权威性，不可修改或重写。' +
                '请直接以文字形式总结专家的工作成果回复用户，' +
                '引导用户到「我的文件」中查看专家的完整产物。'
            })
            appendSessionMessage(sessionId, 'assistant', result, 'tool_result', {
              toolCallId: tc.id,
              toolName: tc.name,
              isError: true
            })
            wrappedEmit('tool_result', {
              tool_call_id: tc.id,
              tool_name: tc.name,
              result,
              is_error: true
            })
            results.push({ id: tc.id, name: tc.name, result })
            continue
          }

          const ctx: ToolExecContext = {
            sessionId,
            emit: wrappedEmit,
            abortSignal,
            toolCallId: tc.id
          }
          const toolT0 = Date.now()
          const result = await executeTool(tc.name, tc.arguments, ctx, byName)
          addEvent(turnId, '工具执行完成', {
            tool_name: tc.name,
            durationMs: Date.now() - toolT0,
            is_error: result.startsWith('{"error":'),
            result_preview: result.slice(0, 200)
          })
          const isError = result.startsWith('{"error":')

          // After session_spawn executes for the first time, mark as
          // delegated and replace the expert delegation directive with a
          // post-delegation rule. The post-delegation rule tells lucid NOT
          // to rewrite or save a new file based on the expert's product —
          // the expert's product is authoritative. Lucid, as a platform
          // that doesn't understand the business domain, must only summarize
          // the expert's result as a text reply.
          if (tc.name === 'session_spawn' && !expertDelegated) {
            expertDelegated = true
            const postDelegationRule =
              `[专家已返回 — 产物不可修改]\n` +
              `专家已完成任务并自行保存了产物文件。专家的产物具有权威性。\n` +
              `你作为平台，不了解业务领域，不可以加工或重写专家的产物。具体禁止：\n` +
              `- 不要调用 save_product 保存或重写专家的产物\n` +
              `- 不要调用 write 工具创建基于专家产物的文件\n` +
              `- 不要修改、重写、润色或加工专家的产物内容\n` +
              `你只需以文字形式总结专家的工作成果，回复用户即可。\n` +
              `如果用户需要查看专家的完整产物，引导用户到「我的文件」中查看。`
            if (fullPrompt.startsWith('[专家委派')) {
              const separatorIdx = fullPrompt.indexOf('\n\n')
              if (separatorIdx >= 0) {
                fullPrompt = postDelegationRule + '\n\n' + fullPrompt.slice(separatorIdx + 2)
              } else {
                fullPrompt = postDelegationRule + '\n\n' + fullPrompt
              }
            } else {
              fullPrompt = postDelegationRule + '\n\n' + fullPrompt
            }
          }

          // For browser_use screenshot results, strip base64 from the
          // persisted + emitted version to avoid JSONL bloat and slow IPC.
          // The full result (with base64) is kept in `results` for the LLM.
          let persistedResult = result
          if (tc.name === 'browser_use' && result.includes('"image":{')) {
            try {
              const parsed = JSON.parse(result) as {
                image?: { base64?: string; mimeType?: string }
              }
              if (parsed.image?.base64) {
                persistedResult = JSON.stringify({
                  ...parsed,
                  image: { mimeType: parsed.image.mimeType ?? 'image/png', omitted: true }
                })
              }
            } catch {
              /* keep original */
            }
          }

          // Persist tool_result message (with expert ref if session_spawn set it)
          appendSessionMessage(sessionId, 'assistant', persistedResult, 'tool_result', {
            toolCallId: tc.id,
            toolName: tc.name,
            isError,
            ...(ctx.expertRef ? { expert: ctx.expertRef } : {})
          })
          wrappedEmit('tool_result', {
            tool_call_id: tc.id,
            tool_name: tc.name,
            result: persistedResult,
            is_error: isError
          })
          results.push({ id: tc.id, name: tc.name, result })
          // Collect file paths from file-generating tools so they can be
          // appended to the final answer text. This ensures file paths are
          // embedded in the assistant message itself — the LLM can see them
          // in conversation history in the next turn without re-searching.
          if (!isError) {
            if (
              tc.name === 'save_product' ||
              tc.name === 'generate_image' ||
              tc.name === 'edit_image' ||
              tc.name === 'write' ||
              tc.name === 'save_skill'
            ) {
              // Tools that return file_path/path in their JSON result
              try {
                const parsed = JSON.parse(result) as Record<string, unknown>
                const fp =
                  typeof parsed.file_path === 'string'
                    ? parsed.file_path
                    : typeof parsed.path === 'string'
                      ? parsed.path
                      : null
                if (fp) {
                  for (const p of expandFilePath(fp)) {
                    generatedFilePaths.push(p)
                  }
                }
              } catch {
                /* not JSON */
              }
            } else if (tc.name === 'code_execute' || tc.name === 'terminal') {
              // Tools that declare written paths via write_paths in arguments
              // (their result only has exit_code/output, no file paths)
              const writePaths = extractWritePathsFromArgs(tc.name, tc.arguments)
              for (const wp of writePaths) {
                for (const p of expandFilePath(wp)) {
                  generatedFilePaths.push(p)
                }
              }
            }
          }
        }

        // Append assistant message with tool_calls
        llmMessages.push({
          role: 'assistant',
          content: currentContent,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
        })

        // Append tool result messages (capped inline)
        for (const r of results) {
          // Detect browser_use screenshot results — construct array-form
          // content with text + image_url so the LLM can see the screenshot.
          if (r.name === 'browser_use' && r.result.includes('"image":{')) {
            try {
              const parsed = JSON.parse(r.result) as {
                image?: { base64: string; mimeType: string }
              }
              if (parsed.image?.base64) {
                const { image: _image, ...rest } = parsed
                let textSummary = JSON.stringify(rest)
                if (textSummary.length > TOOL_RESULT_INLINE_CAP) {
                  textSummary = textSummary.slice(0, TOOL_RESULT_INLINE_CAP) + '\n…[内容过长已截断]'
                }
                llmMessages.push({
                  role: 'tool',
                  tool_call_id: r.id,
                  content: [
                    { type: 'text', text: textSummary },
                    {
                      type: 'image_url',
                      image_url: {
                        url: `data:${parsed.image.mimeType};base64,${parsed.image.base64}`
                      }
                    }
                  ]
                })
                continue
              }
            } catch {
              /* fall through to string handling */
            }
          }

          let inline = r.result
          const cap = r.name === 'session_spawn' ? SESSION_SPAWN_RESULT_CAP : TOOL_RESULT_INLINE_CAP
          if (inline.length > cap) {
            inline = inline.slice(0, cap) + '\n…[内容过长已截断]'
          }
          llmMessages.push({ role: 'tool', tool_call_id: r.id, content: inline })
        }

        // When all todos completed, prompt LLM to produce final answer
        if (getAllCompleted(sessionId)) {
          if (!allTodosDone) {
            allTodosDone = true
            llmMessages.push({
              role: 'user',
              content: '所有任务已完成，请直接给出最终的文字回答，不要调用任何工具。'
            })
          } else {
            // LLM still called tools after being told to stop — force break
            finalText = currentContent.trim() || '（所有任务已完成。）'
            finalStopReason = 'force_break'
            finalTokenCount = totalTokens
            return
          }
        }

        // ── Context compaction: when 80% of context window is used, compress ──
        if (contextWindow > 0 && totalTokens > contextWindow * 0.8) {
          const result = await compactContext(llmMessages, sessionId, emit, model, totalTokens)
          llmMessages = result.messages
          // Update system prompt reference so subsequent iterations use the compressed version
          fullPrompt = (llmMessages[0].content as string) ?? fullPrompt
        }

        continue
      }

      // ── Branch: no tool calls ──
      // The LLM produced no tool calls this iteration. Two cases:
      //  (a) Real final answer — text produced and either no todos exist or
      //      all todos are completed. Terminate cleanly.
      //  (b) Stall — LLM emitted only reasoning, or a fragment like
      //      "让我再搜一下…" as text, while todos are still pending. This
      //      used to be misclassified as a final answer (forceCompleteTodos
      //      was called unconditionally), which terminated the task with the
      //      fragment as the "answer". Now we nudge the LLM to either call
      //      a tool or give a real answer, bounded by emptyTurnCount.
      const finalContent = currentContent.trim()
      const hasPendingTodos = getTodos(sessionId).some((t) => t.status !== 'completed')

      // Gate: when an expert is selected but session_spawn hasn't been called
      // yet, the LLM MUST delegate before producing a final answer. Without
      // this gate, the LLM would just answer directly and the expert would
      // never run.
      const needsExpertDelegation = expertAgentId && !expertDelegated

      if (finalContent && !hasPendingTodos && !needsExpertDelegation) {
        // (a) Real final answer — auto-complete any stragglers (should be
        // none here) and return.
        forceCompleteTodos(sessionId, wrappedEmit)
        finalText = finalContent
        finalStopReason = 'stop'
        finalTokenCount = totalTokens
        return
      }

      // (b) Stall. Don't force-complete todos — the work isn't done.
      emptyTurnCount++
      if (emptyTurnCount > MAX_STALLS) {
        // Give up after MAX_STALLS+1 consecutive stalls. Surface whatever text
        // we have (or an explicit message) so the user isn't left with nothing.
        const fallback = finalContent || '（模型多次未给出有效回答，请重试或换一种问法。）'
        if (!finalContent) {
          wrappedEmit('text_delta', { message_id: assistantMsgId, delta: fallback })
        }
        finalText = fallback
        finalStopReason = 'error'
        finalError = { code: 'STALL', message: '模型多次未给出有效回答或调用工具' }
        return
      }

      // Nudge: tell the LLM to either call a tool or give a complete answer.
      // When an expert is selected but not yet delegated, the nudge is
      // specific — tell the LLM to call session_spawn immediately.
      let nudgeContent: string
      if (needsExpertDelegation) {
        nudgeContent =
          `你选择了专家但还没有调用 session_spawn。请立即调用 session_spawn 工具，` +
          `参数为 { "agentId": "${expertAgentId}", "task": "用户的原始任务描述" }。` +
          `不要直接回答用户问题，必须先通过 session_spawn 委派给专家。`
      } else if (finalContent) {
        nudgeContent = `你刚才输出了「${finalContent.slice(0, 80)}」，但没有调用工具，且任务尚未完成。如果需要搜索或获取信息，请直接调用对应工具（如 web_search）继续；如果信息已足够，请给出完整的最终文字回答。`
      } else {
        nudgeContent =
          '你刚才没有给出最终回答或调用工具。请直接给出完整的文字回答，或者调用合适的工具继续完成任务。'
      }
      llmMessages.push({
        role: 'user',
        content: nudgeContent
      })
      // Reset accumulators for the next iteration
      currentContent = ''
      reasoningContent = ''
      continue
    }

    // ── Max iterations reached ──
    finalText = '（已达到最大执行步骤限制，任务中止。）'
    finalStopReason = 'max_iterations'
    finalError = { code: 'MAX_ITERATIONS', message: '已达到最大执行步骤限制，任务中止。' }
  } finally {
    // 0. Trace: end the turn with final event + stop reason
    addEvent(turnId, finalError ? '任务异常' : '最终回答', {
      stop_reason: finalStopReason,
      token_count: finalTokenCount,
      durationMs: Date.now() - turnStart
    })
    endTurn(turnId, finalStopReason)

    // 1. Messages (thinking, plan, tool_call, tool_result, steer text) were
    //    persisted incrementally during the run — nothing to flush here.

    // 2. MCP runtime is app-level — no per-run teardown. Connections
    //    persist across runs; disposed only on app quit or config reload.

    // 3. Emit error event to renderer (before message_done so errorMessage is set)
    if (finalError) {
      emit('error', {
        error_code: finalError.code,
        message: finalError.message,
        recoverable: false
      })
    }

    // 5. Persist final text answer + emit message_done
    //    Generated file paths are stored as `attachments` on the assistant
    //    message so they appear as visual blocks in the UI. They are also
    //    injected into the LLM context in the next turn (see llmMessages
    //    building above) so the model can reference them without searching.
    if (finalText) {
      const productPaths =
        generatedFilePaths.length > 0 ? [...new Set(generatedFilePaths)] : undefined
      const finalMsg = appendSessionMessage(
        sessionId,
        'assistant',
        finalText,
        'text',
        undefined,
        productPaths
      )
      emit('message_done', {
        message_id: finalMsg.id,
        streaming_message_id: assistantMsgId,
        content: finalText,
        role: 'assistant',
        token_count: finalTokenCount,
        stop_reason: finalStopReason
      })
    }
  }
}

// ── Context compaction ──
// When 80% of the model's context window is used, summarize older messages
// and extract short-term memories synchronously. The agent loop pauses during
// compaction and resumes with the compressed message array.

async function compactContext(
  llmMessages: LlmMessage[],
  sessionId: string,
  emit: Emit,
  model: ModelConfig,
  tokensBefore: number
): Promise<{ messages: LlmMessage[]; memoriesExtracted: number }> {
  // 1. Emit compacting event
  emit('context_compacting', { message: '正在压缩上下文...' })

  // 2. Split: keep system [0] + recent (from last user message), compress the rest
  const systemMsg = llmMessages[0]
  const recentStart = findRecentStart(llmMessages)
  const toCompress = llmMessages.slice(1, recentStart)
  const recent = llmMessages.slice(recentStart)

  if (toCompress.length === 0) {
    emit('context_compacted', { tokensBefore, tokensAfter: tokensBefore, memoriesExtracted: 0 })
    return { messages: llmMessages, memoriesExtracted: 0 }
  }

  // 3. Build conversation text from toCompress
  const conversationText = toCompress
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : ''
      if (m.role === 'user') return `用户: ${content}`
      if (m.role === 'assistant') {
        const toolNames = m.tool_calls?.map((tc) => tc.function.name).join(', ') ?? ''
        return `助手: ${content}${toolNames ? ` (调用了工具: ${toolNames})` : ''}`
      }
      if (m.role === 'tool') return `工具结果: ${content}`
      return content
    })
    .join('\n\n')

  // 4. Call LLM to summarize
  const summary = await summarizeConversation(conversationText, model)

  // 5. Extract memories synchronously (not via async queue)
  const messagesForExtraction: Message[] = toCompress
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0
    )
    .map((m) => ({
      id: '',
      role: m.role as 'user' | 'assistant',
      content: m.content as string,
      createdAt: Date.now(),
      type: 'text' as MessageType
    }))
  const memoriesExtracted = await extractMemoriesDirect(
    sessionId,
    messagesForExtraction,
    'compaction'
  )

  // 6. Rebuild llmMessages: system (with summary) + recent
  const systemContent = typeof systemMsg.content === 'string' ? systemMsg.content : ''
  const newSystemContent = systemContent + '\n\n[前序对话摘要]\n' + summary
  const newMessages: LlmMessage[] = [{ ...systemMsg, content: newSystemContent }, ...recent]

  // 7. Estimate tokensAfter (rough: 1 token ≈ 4 chars)
  const totalChars = newMessages.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    return sum + c.length
  }, 0)
  const tokensAfter = Math.ceil(totalChars / 4)

  // 8. Emit compacted event
  emit('context_compacted', { tokensBefore, tokensAfter, memoriesExtracted })
  console.log(
    `[Agent] Context compacted: ${tokensBefore} → ~${tokensAfter} tokens, ${memoriesExtracted} memories extracted`
  )

  return { messages: newMessages, memoriesExtracted }
}

// Find the start index of the "recent" section to preserve during compaction.
// Preserves the last K tool results and their originating assistant messages,
// so the LLM retains recent file contents, quality-check errors, and other
// tool outputs needed to fix issues — even after compaction strips earlier
// conversation history.
//
// The previous implementation found the last user message, but system-injected
// nudges ("你刚才没有调用工具…") are also user messages. When stalls occurred,
// nudges became the "recent" start, compressing away the tool results the LLM
// needed to fix the problem — compounding the stall.
function findRecentStart(llmMessages: LlmMessage[]): number {
  const MIN_PRESERVED_TOOL_RESULTS = 6

  let toolResultCount = 0
  for (let i = llmMessages.length - 1; i >= 1; i--) {
    if (llmMessages[i].role === 'tool') {
      toolResultCount++
      if (toolResultCount >= MIN_PRESERVED_TOOL_RESULTS) {
        // Walk back to the assistant message with tool_calls that
        // originated this tool-call sequence (tool messages must follow
        // an assistant with tool_calls).
        let j = i
        while (j > 1 && llmMessages[j].role !== 'assistant') {
          j--
        }
        return Math.max(1, j)
      }
    }
  }

  // Fewer than K tool results total — preserve the last few messages.
  return Math.max(1, llmMessages.length - 4)
}

async function summarizeConversation(text: string, model: ModelConfig): Promise<string> {
  const client = getOrCreateClient(model)
  try {
    const response = await client.chat.completions.create({
      model: model.name,
      messages: [
        {
          role: 'user',
          content: `请将以下对话摘要为简洁的背景信息，保留关键决策、工具调用结果和任务进度。摘要应该能让后续对话理解之前发生了什么：

${text}

请直接输出摘要，不要输出其他内容。不要使用 JSON 格式。`
        }
      ],
      temperature: 0.3,
      max_tokens: 1000
    })
    return response.choices[0]?.message?.content?.trim() ?? ''
  } catch (e) {
    console.error('[Agent] Summarization failed:', e)
    return '（摘要生成失败）'
  }
}
