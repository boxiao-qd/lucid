// save_memory tool — LLM-based memory extraction from conversation context.
//
// When the agent calls this tool, it gathers text-only messages (user questions
// + assistant answers, excluding tool calls/results/thinking/plan) from the
// session, sends them to the LLM for memory extraction, and inserts new
// memories with dedup against ALL existing memories (short + long tiers).
//
// The agent decides WHEN to call this tool; the extraction LLM decides WHAT
// to save. This avoids redundant agent-side judgment and provides systematic
// extraction from the full conversation context.

import type { ToolDef, ToolExecContext } from '../tool-def'
import { isDbAvailable } from '../../memory/memory-db'
import { extractMemoriesDirect } from '../../memory/memory-extract'
import { getSessionMessages } from '../../sessions'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'save_memory',
    description:
      '从当前对话中提取值得长期记住的记忆。自动分析用户本轮提问、智能体的回答（不含工具内容）以及历史对话问答（不含工具内容），提取记忆并与已有记忆去重。无需传参，直接调用即可。',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }
}

async function execute(_argsStr: string, ctx: ToolExecContext): Promise<string> {
  if (!isDbAvailable()) {
    return JSON.stringify({ error: '记忆数据库未初始化' })
  }

  // Gather text-only messages from session (user questions + assistant
  // text answers, excluding tool_call/tool_result/thinking/plan).
  const allMessages = getSessionMessages(ctx.sessionId)
  const textMessages = allMessages.filter((m) => m.type === 'text' && m.content && m.content.trim())

  if (textMessages.length === 0) {
    return JSON.stringify({ error: '没有可提取的对话内容' })
  }

  // extractMemoriesDirect handles:
  // - carrying all existing memories in the extraction prompt (LLM-level dedup)
  // - hash-based dedup against both short and long tiers
  // - inserting new memories (short tier) with embeddings
  const inserted = await extractMemoriesDirect(ctx.sessionId, textMessages, 'llm_judgment')

  if (inserted === 0) {
    return JSON.stringify({
      result: 'no_new_memories',
      message: '本轮对话中没有发现值得新增长期记忆的内容'
    })
  }

  return JSON.stringify({
    result: 'extracted',
    count: inserted
  })
}

export const saveMemoryTool: ToolDef = {
  name: 'save_memory',
  openai: TOOL_DEF,
  execute
}
