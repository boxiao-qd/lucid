// LLM client — routes requests to the active model endpoint.
// Single API key from settings (no rotation). OpenAI SDK streaming with
// AbortController support. Context overflow detection via error message patterns.
//
// Client instances are cached per (endpoint, apiKey) so the underlying fetch
// dispatcher / undici connection pool can reuse TCP/TLS connections across
// agent runs instead of paying a fresh handshake on every message.

import OpenAI from 'openai'
import type { ModelConfig } from '../../shared/types'

// Context overflow detection patterns
const OVERFLOW_PATTERNS = [
  'request_too_large',
  'request exceeds the maximum size',
  'context length exceeded',
  'maximum context length',
  'prompt is too long',
  'exceeds model context window',
  'context overflow',
  '413'
]

export class ContextOverflowError extends Error {
  original?: unknown
  constructor(message: string, original?: unknown) {
    super(message)
    this.name = 'ContextOverflowError'
    this.original = original
  }
}

function isContextOverflow(err: unknown): boolean {
  const text = String(err ?? '').toLowerCase()
  return OVERFLOW_PATTERNS.some((p) => text.includes(p))
}

// Per-(endpoint, apiKey) singleton cache. Reusing the same OpenAI instance
// lets Node's fetch / undici global dispatcher pool keep the TCP/TLS
// connection alive across runs. Keyed by endpoint + apiKey so switching
// models or rotating keys picks up correctly.
const CLIENT_CACHE = new Map<string, OpenAI>()

function clientKey(model: ModelConfig): string {
  return `${model.endpoint}::${model.apiKey ?? ''}`
}

export function getOrCreateClient(model: ModelConfig): OpenAI {
  const key = clientKey(model)
  let client = CLIENT_CACHE.get(key)
  if (!client) {
    client = new OpenAI({
      baseURL: model.endpoint,
      apiKey: model.apiKey || 'empty',
      timeout: 60000,
      maxRetries: 0
    })
    CLIENT_CACHE.set(key, client)
  }
  return client
}

// Warm up the TCP/TLS connection for a model by issuing a cheap request
// before the first real agent run. Best-effort: if the endpoint rejects
// /v1/models (some OpenAI-compatible providers don't implement it), the
// error is swallowed — the agent loop still works, it just pays the
// handshake on the first real message.
export async function warmupClient(model: ModelConfig): Promise<void> {
  const client = getOrCreateClient(model)
  try {
    await client.models.list()
  } catch {
    // Silent — warmup is best-effort. First real request will establish
    // the connection if this failed.
  }
}

// OpenAI chat message shape (system/user/assistant/tool with optional tool_calls)
// content can be a string or an array of content parts (for multimodal messages
// with text + image_url). Only user messages use the array form in practice.
export type LlmContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmContentPart[]
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export interface ToolCallAccum {
  id: string
  name: string
  arguments: string
}

export interface StreamCallbacks {
  onReasoning?: (delta: string) => void
  onText?: (delta: string) => void
  onToolCallStart?: (id: string, name: string) => void
  onToolCallDelta?: (id: string, argsDelta: string, partialArgs: string) => void
  onUsage?: (totalTokens: number) => void
}

// Stream a chat completion. Parses delta.reasoning_content (thinking),
// delta.content (text, with <HIS_THOUGHT_START>/<HIS_THOUGHT_END> tag routing
// as a compatibility fallback), and delta.tool_calls (accumulated by index).
// Throws ContextOverflowError on context-length errors; other errors propagate.
export async function streamChat(
  client: OpenAI,
  model: ModelConfig,
  messages: LlmMessage[],
  tools: { type: 'function'; function: { name: string } }[] | undefined,
  signal: AbortSignal,
  cb: StreamCallbacks,
  steerQueue?: string[]
): Promise<{ toolCalls: ToolCallAccum[]; totalTokens: number; steered: boolean }> {
  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

  try {
    const result = await client.chat.completions.create(
      {
        model: model.name,
        messages: messages as never,
        tools: tools as never,
        stream: true,
        stream_options: { include_usage: true }
      } as never,
      { signal }
    )
    stream = result as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
  } catch (err) {
    if (isContextOverflow(err)) {
      throw new ContextOverflowError(
        `Context overflow detected for model=${model.name}: ${err}`,
        err
      )
    }
    throw err
  }

  const toolCalls: ToolCallAccum[] = []
  let totalTokens = 0
  let inThinkTag = false
  let thinkBuffer = ''

  const THINK_START = '<HIS_THOUGHT_START>'
  const THINK_END = '<HIS_THOUGHT_END>'

  for await (const chunk of stream) {
    if (signal.aborted) break

    if (!chunk.choices || chunk.choices.length === 0) {
      if (chunk.usage) {
        totalTokens = chunk.usage.total_tokens ?? 0
        cb.onUsage?.(totalTokens)
      }
      continue
    }

    const delta = chunk.choices[0].delta as Record<string, unknown>

    // reasoning_content — DeepSeek/o1-style thinking (cleaner than tags)
    const reasoning = delta.reasoning_content
    if (typeof reasoning === 'string' && reasoning) {
      cb.onReasoning?.(reasoning)
    }

    // content — may contain <HIS_THOUGHT_START>/<HIS_THOUGHT_END> tags for
    // models that embed thinking inline. Route accordingly.
    const text = delta.content
    if (typeof text === 'string' && text) {
      for (const char of text) {
        thinkBuffer += char
        if (!inThinkTag) {
          if (thinkBuffer.includes(THINK_START)) {
            inThinkTag = true
            const idx = thinkBuffer.indexOf(THINK_START)
            const before = thinkBuffer.slice(0, idx)
            if (before) cb.onText?.(before)
            thinkBuffer = ''
          } else if (thinkBuffer.length > 20) {
            cb.onText?.(thinkBuffer)
            thinkBuffer = ''
          }
        } else {
          if (thinkBuffer.includes(THINK_END)) {
            inThinkTag = false
            const idx = thinkBuffer.indexOf(THINK_END)
            const thinkContent = thinkBuffer.slice(0, idx)
            if (thinkContent) cb.onReasoning?.(thinkContent)
            thinkBuffer = ''
          } else if (thinkBuffer.length > 5) {
            // Safe-flush: keep a trailing prefix that could be part of THINK_END
            let keep = ''
            for (let i = THINK_END.length - 1; i > 0; i--) {
              if (thinkBuffer.endsWith(THINK_END.slice(0, i))) {
                keep = thinkBuffer.slice(-i)
                break
              }
            }
            const flushPart = keep ? thinkBuffer.slice(0, -keep.length) : thinkBuffer
            if (flushPart) cb.onReasoning?.(flushPart)
            thinkBuffer = keep
          }
        }
      }
    }

    // tool_calls — accumulate by index
    // Before processing tool calls, flush any pending text buffer so the
    // narration text appears before the tool call card in the UI. Without
    // this, text stays buffered (the 20-char flush threshold hasn't been
    // met) while tool_call_start fires immediately, causing the narration
    // to appear split around the tool call card.
    if (thinkBuffer && !inThinkTag) {
      cb.onText?.(thinkBuffer)
      thinkBuffer = ''
    }
    const tcs = delta.tool_calls as
      | Array<{
          index: number
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      | undefined
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        const idx = tc.index
        while (toolCalls.length <= idx) {
          toolCalls.push({ id: '', name: '', arguments: '' })
        }
        if (tc.id) {
          toolCalls[idx].id = tc.id
          const name = tc.function?.name ?? toolCalls[idx].name
          if (name) {
            toolCalls[idx].name = name
            cb.onToolCallStart?.(tc.id, name)
          }
        }
        if (tc.function?.arguments) {
          toolCalls[idx].arguments += tc.function.arguments
          cb.onToolCallDelta?.(toolCalls[idx].id, tc.function.arguments, toolCalls[idx].arguments)
        }
      }
    }

    if (chunk.usage) {
      totalTokens = chunk.usage.total_tokens ?? 0
      cb.onUsage?.(totalTokens)
    }

    // Steer check — if user supplemented info mid-stream, break to let
    // agent-runner inject it and re-call the LLM.
    if (steerQueue && steerQueue.length > 0) {
      break
    }
  }

  const steered = !!steerQueue && steerQueue.length > 0

  // Flush remaining think buffer (skip if steered — partial output discarded)
  if (!steered && thinkBuffer) {
    if (inThinkTag) {
      cb.onReasoning?.(thinkBuffer)
    } else {
      cb.onText?.(thinkBuffer)
    }
  }

  // Discard partial tool calls when steered
  return { toolCalls: steered ? [] : toolCalls, totalTokens, steered }
}
