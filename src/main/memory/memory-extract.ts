// Memory extraction — direct LLM consumer.
// Used by context compaction: when old messages are about to be discarded
// to make room for new ones, extract memory-worthy content from them first.
// Per-turn and session-end extraction are handled by the agent calling the
// save_memory tool during the conversation — no background queue needed.

import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import type { Message, ExtractionTrigger } from '../../shared/types'
import { readSettings } from '../settings'
import {
  isDbAvailable,
  insertMemory,
  getMemoryByHashAny,
  getAllMemories,
  insertVector
} from './memory-db'
import { getEmbedding } from './embedding-provider'

// Direct (synchronous) extraction — used by context compaction.
// Analyzes the given messages, extracts memory-worthy content, and inserts
// new memories (with hash-based dedup against all existing memories).
export async function extractMemoriesDirect(
  sessionId: string,
  messages: Message[],
  trigger: ExtractionTrigger
): Promise<number> {
  if (!isDbAvailable() || messages.length === 0) return 0
  return processExtractionTask({ sessionId, messages, trigger })
}

// ── Consumer — core extraction logic ──

interface ExtractionTask {
  sessionId: string
  messages: Message[]
  trigger: ExtractionTrigger
}

async function processExtractionTask(task: ExtractionTask): Promise<number> {
  const { sessionId, messages, trigger } = task
  if (messages.length === 0) return 0

  try {
    // Carry ALL existing memories (short + long) to prevent duplicate extraction
    const existing = getAllMemories()
    const existingContent = existing.map((m) => m.content).join('\n- ')

    // Build conversation text for the LLM (no cap — full messages)
    const conversationText = messages
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n\n')

    const prompt = buildExtractionPrompt(conversationText, existingContent, trigger)

    // Call LLM — use main model (auxiliary is embedding-only, can't do chat)
    const settings = readSettings()
    const mainModel = settings.main.find((m) => m.active) ?? settings.main[0]
    if (!mainModel) return 0

    const client = new OpenAI({
      baseURL: mainModel.endpoint,
      apiKey: mainModel.apiKey || 'empty',
      timeout: 30000,
      maxRetries: 1
    })

    let responseText: string
    try {
      const response = await client.chat.completions.create({
        model: mainModel.name,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      })
      responseText = response.choices[0]?.message?.content?.trim() ?? ''
    } catch (e) {
      console.error('[Memory] Extraction LLM call failed:', e)
      return 0
    }

    // Parse JSON array of memory strings
    const newMemories = parseExtractionResult(responseText)
    if (newMemories.length === 0) return 0

    // Insert with dedup — new memories are always 'short' tier
    let inserted = 0
    for (const content of newMemories) {
      const trimmed = content.trim()
      if (!trimmed) continue

      const hash = sha256(trimmed)
      if (getMemoryByHashAny(hash)) continue // dedup against both tiers

      const mem = insertMemory('short', trimmed, sessionId, trigger)
      if (mem) {
        inserted++
        // Generate embedding and insert vector (best-effort)
        const embedding = await getEmbedding(trimmed)
        if (embedding.length > 0) {
          insertVector(mem.id, embedding)
        }
      }
    }

    if (inserted > 0) {
      console.log(
        `[Memory] ${trigger === 'session_end' ? 'Session-end' : trigger === 'llm_judgment' ? 'LLM judgment' : 'Compaction'} extraction for ${sessionId}: ${inserted} new memories`
      )
    }

    return inserted
  } catch (e) {
    console.error(`[Memory] Extraction failed for ${sessionId} (${trigger}):`, e)
    return 0
  }
}

function buildExtractionPrompt(
  conversationText: string,
  existingContent: string,
  trigger: ExtractionTrigger
): string {
  const triggerLabel =
    trigger === 'session_end'
      ? '会话结束'
      : trigger === 'llm_judgment'
        ? '对话中发现'
        : '上下文压缩'

  return `你是一个记忆提取助手。请分析以下对话，提取真正值得长期记住的记忆。

## 提取标准（严格）

只提取满足以下条件的信息：
- **用户偏好或习惯**：如"我喜欢用 TypeScript"、"我习惯先写测试再写实现"
- **持久的事实知识**：如"项目使用 React + Electron 技术栈"、"用户是数据科学家"
- **重要决策或约定**：如"决定使用 Boogu-Image 作为图片生成模型"、"测试必须用真实数据库"
- **用户画像**：如"用户熟悉 Go 但刚接触 React"

## 不提取（严格排除）

- 一次性任务的具体内容（"画一只猫"、"帮我写一个函数"、"生成报告"）
- 对话中的临时性问答（"这个文件是什么"、"结果在哪"）
- 工具调用的参数和返回值
- 已经是常识或可从代码/配置中直接获得的信息
- 用户的情绪、语气、礼貌用语
- 代码片段、命令、技术实现的临时细节
- 已完成的一次性工作描述

## 输出要求

- 每条记忆为一句话，简洁完整，能脱离原始对话独立理解
- 不要重复提取已有记忆中相同或高度相似的内容
- **宁可不提取，也不要提取低价值内容**
- 如果对话中没有真正值得长期记住的内容，输出 []（这是常见情况，不要勉强提取）

已有记忆（不要重复提取）：
${existingContent ? '- ' + existingContent : '（暂无）'}

触发场景：${triggerLabel}

对话内容：
${conversationText}

请以 JSON 数组形式输出提取的记忆，每条为一句话。如果没有值得记住的内容，输出 []。只输出 JSON 数组，不要任何额外说明。`
}

// Parse the LLM response as a JSON array of strings.
// Handles common formatting issues (markdown code blocks, extra text).
function parseExtractionResult(text: string): string[] {
  let cleaned = text.trim()

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  // Find JSON array boundaries
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []

  const jsonStr = cleaned.slice(start, end + 1)
  try {
    const parsed = JSON.parse(jsonStr) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    )
  } catch {
    return []
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
