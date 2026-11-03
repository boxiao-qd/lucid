// memory_search tool — on-demand memory recall.
//
// Architecture: memory retrieval is a TOOL the agent calls when it needs to
// recall user preferences, past experiences, or important facts. This avoids
// firing a concurrent rewriteQuery LLM call at the start of every turn (which
// competed with streamChat for first token). Instead, rewriteQuery fires
// inside this tool call — after the first token has already arrived.
//
// Two modes:
//   1. query provided → use it directly for search (skip rewrite)
//   2. query omitted → auto-rewrite from recent conversation context
//      (last 2 user questions + last 1 assistant answer, text only)
//      then search with the rewritten query.

import OpenAI from 'openai'
import { getSessionMessages } from '../../sessions'
import { readSettings } from '../../settings'
import { hybridSearch } from '../../memory/memory-search'
import { isDbAvailable } from '../../memory/memory-db'
import type { Message } from '../../../shared/types'
import type { ToolDef, ToolExecContext } from '../tool-def'

const MEMORY_SEARCH_LIMIT = 10

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'memory_search',
    description:
      '搜索长期记忆，回忆用户偏好、过往经历、重要决策和事实知识。' +
      '当需要回忆之前对话中提到过的信息，或者发现缺少必要信息来完整回答用户问题时，调用此工具。' +
      '不传 query 参数时，会自动根据最近对话上下文重写查询；' +
      '传了 query 参数时，直接用该查询搜索，跳过重写。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '搜索查询（可选）。如果明确要搜某个关键词，传入查询直接搜索。' +
            '如果不传，工具会自动根据最近对话上下文生成搜索查询。'
        }
      },
      required: []
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  if (!isDbAvailable()) {
    return JSON.stringify({ error: '记忆数据库未初始化' })
  }

  let args: { query?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const explicitQuery = typeof args.query === 'string' ? args.query.trim() : ''

  // Determine the search query
  let query: string
  if (explicitQuery) {
    // Mode 1: explicit query — skip rewrite
    query = explicitQuery
  } else {
    // Mode 2: auto-rewrite from conversation context
    const messages = getSessionMessages(ctx.sessionId)
    const recent = getRecentForRewrite(messages)
    if (recent.length === 0) {
      return JSON.stringify({ error: '没有足够的对话上下文来生成搜索查询，请传入 query 参数' })
    }
    query = await rewriteQuery(recent)
    if (!query.trim()) {
      return JSON.stringify({ results: [] })
    }
  }

  // Search memories
  const results = await hybridSearch(query, MEMORY_SEARCH_LIMIT)
  if (results.length === 0) {
    return JSON.stringify({ query, results: [], message: '没有找到相关记忆' })
  }

  return JSON.stringify({
    query,
    results: results.map((r) => ({
      content: r.memory.content,
      tier: r.memory.tier,
      score: Math.round(r.score * 1000) / 1000,
      created_at: new Date(r.memory.createdAt).toISOString().slice(0, 10)
    })),
    total: results.length
  })
}

// Extract last 2 user questions + last 1 assistant answer (text type only,
// no tool content) from session messages for query rewriting.
function getRecentForRewrite(messages: Message[]): { role: string; content: string }[] {
  const textMessages = messages.filter((m) => m.type === 'text' && m.content && m.content.trim())
  const result: { role: string; content: string }[] = []
  let assistantCount = 0
  let userCount = 0

  // Walk backwards through text messages
  for (let i = textMessages.length - 1; i >= 0; i--) {
    const msg = textMessages[i]
    if (msg.role === 'assistant' && assistantCount < 1) {
      result.unshift({ role: 'assistant', content: msg.content })
      assistantCount++
    } else if (msg.role === 'user' && userCount < 2) {
      result.unshift({ role: 'user', content: msg.content })
      userCount++
    }
    if (assistantCount >= 1 && userCount >= 2) break
  }

  return result
}

// Rewrite recent conversation context into a focused search query via LLM.
// Falls back to last user message on failure.
async function rewriteQuery(recentMessages: { role: string; content: string }[]): Promise<string> {
  const settings = readSettings()
  const mainModel = settings.main.find((m) => m.active) ?? settings.main[0]
  if (!mainModel) {
    const lastUser = [...recentMessages].reverse().find((m) => m.role === 'user')
    return lastUser?.content ?? ''
  }

  const conversationText = recentMessages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
    .join('\n')

  const prompt = `你是一个搜索查询重写助手。根据以下对话上下文，生成一个用于检索相关长期记忆的搜索查询。
搜索查询应该能匹配到与当前对话主题相关的用户偏好、过往经历、重要决策或事实知识。
只输出搜索查询本身，不要任何额外说明。查询长度不超过 50 个字。

对话上下文：
${conversationText}

搜索查询：`

  try {
    const client = new OpenAI({
      baseURL: mainModel.endpoint,
      apiKey: mainModel.apiKey || 'empty',
      timeout: 15000,
      maxRetries: 1
    })

    const response = await client.chat.completions.create({
      model: mainModel.name,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 100
    })

    const rewritten = response.choices[0]?.message?.content?.trim() ?? ''
    if (rewritten) return rewritten
  } catch (e) {
    console.error('[Memory] Query rewrite failed, using fallback:', e)
  }

  // Fallback: use last user message
  const lastUser = [...recentMessages].reverse().find((m) => m.role === 'user')
  return lastUser?.content ?? ''
}

export const memorySearchTool: ToolDef = {
  name: 'memory_search',
  openai: TOOL_DEF,
  execute
}
