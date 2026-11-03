// edit_image tool — edits an existing image via the Qwen-Image-2.1-Turbo
// images/edits endpoint (OpenAI-compatible multipart form).
//
// The edit goes through POST {endpoint}/v1/images/edits: the input image is
// uploaded as a multipart file part, and the edit instruction is sent as the
// `prompt` field. The previous /chat/completions path for edits has been
// retired by the provider.
//
// Critical constraint: the edit endpoint MUST NOT receive any generation
// params (size/steps/seed/etc.) — carrying them causes the edit to silently
// degrade into a stylized re-render instead of a true edit.
//
// Input image paths come from three scenarios, all unified as file_path:
//   1. user-uploaded image (saved under workspace/upload/)
//   2. a previous generate_image result (its returned file_path)
//   3. a user-specified disk path (must be inside ~/.lucid/workspace)

import { basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { saveProductBinary, assertWithinWorkspace } from '../../uploads'
import { readSettings } from '../../settings'
import { getOrCreateClient } from '../llm-client'
import { isWorkspaceGuardEnabled } from '../workspace-guard'
import type { ToolDef, ToolExecContext } from '../tool-def'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'edit_image',
    description:
      '编辑/修改已有图片并保存到当前会话的产物目录。' +
      '当用户要求对现有图片做修改（换背景、加元素、改风格、变换内容等）时调用此工具，而不是 generate_image。' +
      '传入输入图片路径和编辑指令，返回编辑后的图片路径。\n' +
      '【prompt 编写规则】\n' +
      '1. prompt 写的是「要对图片做什么改动」，如「把背景换成海边日落」「给人物加上眼镜」「整体调成暖色调」\n' +
      '2. 不要写纯视觉画面描述（那是 generate_image 的写法），这里写的是编辑指令',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            '要编辑的输入图片完整路径。来源可以是：用户上传图片的路径、前序 generate_image 返回的 file_path、或用户指定的 workspace 内磁盘路径。路径必须在 ~/.lucid/workspace 下。'
        },
        prompt: {
          type: 'string',
          description: '编辑指令，描述要对图片做什么修改。如「把背景换成海边日落」'
        },
        purpose: {
          type: 'string',
          description:
            '本次编辑的用途/意图（如「把猫咪照片背景换成海边日落」），会展示给用户看，便于理解这次编辑在做什么'
        },
        filename: {
          type: 'string',
          description: '输出文件名（不含扩展名），默认取输入文件名 + _edited。必须使用中文名'
        }
      },
      required: ['file_path', 'prompt', 'purpose']
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { file_path?: unknown; prompt?: unknown; purpose?: unknown; filename?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
  if (!filePath) {
    return JSON.stringify({ error: 'file_path is required' })
  }

  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) {
    return JSON.stringify({ error: 'prompt is required' })
  }

  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : ''

  // Workspace containment guard — all legitimate input paths (uploads,
  // products, user-specified) resolve under ~/.lucid/workspace.
  // Safe mode (or unrestricted with the secondary toggle off) always enforces
  // this check; unrestricted + explicit user opt-out skips it.
  if (isWorkspaceGuardEnabled()) {
    try {
      assertWithinWorkspace(filePath)
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Read the input image as a Buffer for multipart upload
  let imageBuffer: Buffer
  try {
    imageBuffer = readFileSync(filePath)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to read image file: ${msg}` })
  }
  if (imageBuffer.length === 0) {
    return JSON.stringify({ error: '输入图片数据为空' })
  }

  // Infer MIME from extension (images/edits expects an image/* content type)
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'bmp'
            ? 'image/bmp'
            : 'image/png'
  const imageFile = new File([new Uint8Array(imageBuffer)], basename(filePath), { type: mime })

  // Get the imageGen model from settings (same model that does generation)
  const settings = readSettings()
  const model = settings.imageGen.find((m) => m.active)
  if (!model) {
    return JSON.stringify({
      error: '未配置图片生成模型，无法编辑图片。请在设置中配置图片生成模型。'
    })
  }

  const client = getOrCreateClient(model)

  // Build request body — ONLY model + image + prompt + n + response_format.
  // Do NOT add size/steps/seed/guidance/negative_prompt: the edit endpoint
  // rejects generation params (carrying them causes a silent degrade into
  // stylized re-render).
  try {
    const response = await client.images.edit(
      {
        model: model.name,
        image: imageFile,
        prompt,
        n: 1,
        response_format: 'b64_json'
      },
      { signal: ctx.abortSignal }
    )

    // images/edits returns { data: [{ b64_json?, url? }] } — same shape as
    // images/generations.
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
      return JSON.stringify({ error: '编辑 API 未在响应中返回图片数据' })
    }

    const buffer = Buffer.from(b64, 'base64')
    if (buffer.length === 0) {
      return JSON.stringify({ error: '编辑后的图片数据为空' })
    }

    // Determine filename — default to {inputBasename}_edited
    const inputBase = basename(filePath).replace(/\.[^.]+$/, '') || 'image'
    const outBase =
      typeof args.filename === 'string' && args.filename.trim()
        ? args.filename.trim()
        : `${inputBase}_edited`
    const filename = `${outBase}.png`

    // Save to the parent session's product directory (same as generate_image)
    const productSessionId = ctx.parentSessionId ?? ctx.sessionId
    const savedPath = saveProductBinary(productSessionId, buffer, filename, ctx.runId)

    return JSON.stringify({
      success: true,
      file_path: savedPath,
      filename,
      size: buffer.length,
      prompt,
      purpose,
      model: model.name,
      input_path: filePath
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `图片编辑失败: ${msg}` })
  }
}

export const editImageTool: ToolDef = {
  name: 'edit_image',
  openai: TOOL_DEF,
  execute
}
