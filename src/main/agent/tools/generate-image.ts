// generate_image tool — calls an OpenAI-compatible image generation API
// (e.g. Boogu-Image) to create an image from a text prompt, saves the result
// PNG to the session's product directory.
//
// The API must be OpenAI-compatible: POST {endpoint}/images/generations with
// { model, prompt, size, n, response_format, ... } and return b64_json.

import { saveProductBinary } from '../../uploads'
import { readSettings } from '../../settings'
import { getOrCreateClient } from '../llm-client'
import type { ToolDef, ToolExecContext } from '../tool-def'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'generate_image',
    description:
      '根据文字描述生成图片并保存到当前会话的产物目录。' +
      '当你需要为用户创建图片、插图、设计稿等视觉内容时调用此工具。' +
      '支持指定尺寸、推理步数、随机种子等参数。返回保存的文件路径。\n' +
      '【prompt 编写规则 — 重要】\n' +
      '1. prompt 必须是纯视觉描述，描述画面中应该出现什么，不要写任何指令性或说明性文字\n' +
      '2. 正确写法：「一只白色的猫坐在月光下的窗台上，远处是城市灯光，柔和的蓝色调」\n' +
      '3. 错误写法：「请帮我画一只猫，它坐在窗台上，要有月光」— 这种写法会导致图片上出现文字\n' +
      '4. 描述要包含：主体、场景、光线、色调、构图、风格等视觉要素\n' +
      '5. 如果用户提供了参考图片，先用 vision 工具分析图片的视觉特征（构图、色调、主体、风格），再将这些视觉特征转化为简洁的画面描述作为 prompt，不要把 vision 返回的文字描述直接当作 prompt',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '纯视觉画面描述。不要包含任何指令、请求、说明性文字，只描述画面本身。' +
            '正确示例：「一只白色猫咪坐在月光下的窗台上，远处城市灯火，柔和蓝色调，写实风格」'
        },
        size: {
          type: 'string',
          description: '图片尺寸，默认 1024x1024。可选如 1024x1024、1024x1792、1792x1024'
        },
        steps: {
          type: 'number',
          description: '推理步数，控制生成质量和速度，默认 4，范围 1-10'
        },
        guidance: {
          type: 'number',
          description: '引导强度，控制图片与提示词的一致性（可选）'
        },
        seed: {
          type: 'number',
          description: '随机种子，相同种子+相同参数可复现相同图片（可选）'
        },
        negative_prompt: {
          type: 'string',
          description: '反向提示词，描述不想在图片中出现的内容（可选）'
        },
        filename: {
          type: 'string',
          description: '输出文件名（不含扩展名），默认取 prompt 前 20 字。必须使用中文名'
        }
      },
      required: ['prompt']
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: {
    prompt?: unknown
    size?: unknown
    steps?: unknown
    guidance?: unknown
    seed?: unknown
    negative_prompt?: unknown
    filename?: unknown
  }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) {
    return JSON.stringify({ error: 'prompt is required' })
  }

  const size = typeof args.size === 'string' && args.size ? args.size : '1024x1024'
  const steps = typeof args.steps === 'number' && args.steps > 0 ? args.steps : 4
  const guidance = typeof args.guidance === 'number' ? args.guidance : undefined
  const seed = typeof args.seed === 'number' ? args.seed : undefined
  const negativePrompt =
    typeof args.negative_prompt === 'string' && args.negative_prompt
      ? args.negative_prompt
      : undefined

  // Get the imageGen model from settings
  const settings = readSettings()
  const model = settings.imageGen.find((m) => m.active)
  if (!model) {
    return JSON.stringify({
      error: '未配置图片生成模型，无法生成图片。请在设置中配置图片生成模型。'
    })
  }

  // Build request body — start with standard OpenAI params, then add
  // Boogu-specific extensions (steps, guidance, seed, negative_prompt).
  const body: Record<string, unknown> = {
    model: model.name,
    prompt,
    n: 1,
    size,
    response_format: 'b64_json'
  }
  body.steps = steps
  if (guidance !== undefined) body.guidance = guidance
  if (seed !== undefined) body.seed = seed
  if (negativePrompt !== undefined) body.negative_prompt = negativePrompt

  const client = getOrCreateClient(model)

  try {
    const response = await client.images.generate(
      body as never,
      {
        signal: ctx.abortSignal
      } as never
    )

    const result = response as unknown as {
      data?: Array<{ b64_json?: string; url?: string }>
    }

    const b64 = result.data?.[0]?.b64_json
    if (!b64) {
      const url = result.data?.[0]?.url
      if (url) {
        return JSON.stringify({
          error: 'API 返回了 URL 而非 base64，暂不支持。请检查 response_format 配置。',
          url
        })
      }
      return JSON.stringify({ error: '图片生成 API 未返回图片数据' })
    }

    // Decode base64 → Buffer
    const buffer = Buffer.from(b64, 'base64')

    // Determine filename
    const baseName =
      typeof args.filename === 'string' && args.filename.trim()
        ? args.filename.trim()
        : prompt.slice(0, 20).replace(/\s+/g, '_') || 'generated'
    const filename = `${baseName}.png`

    // Save to the parent session's product directory (same as save_product)
    const productSessionId = ctx.parentSessionId ?? ctx.sessionId
    const filePath = saveProductBinary(productSessionId, buffer, filename, ctx.runId)

    return JSON.stringify({
      success: true,
      file_path: filePath,
      filename,
      size: buffer.length,
      prompt,
      model: model.name
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `图片生成失败: ${msg}` })
  }
}

export const generateImageTool: ToolDef = {
  name: 'generate_image',
  openai: TOOL_DEF,
  execute
}
