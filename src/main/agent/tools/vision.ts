// vision tool — reads an image file and uses the multimodal model to describe it.
// This lets the agent "see" images even when the main model has no vision support.
// The tool reads the image from disk as base64, sends it to the multimodal model
// with a description prompt, and returns the text description to the agent.

import { readUploadAsDataUrl, assertWithinWorkspace } from '../../uploads'
import { readSettings } from '../../settings'
import { getOrCreateClient } from '../llm-client'
import { isWorkspaceGuardEnabled } from '../workspace-guard'
import type { ToolDef, ToolExecContext } from '../tool-def'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'vision',
    description:
      '读取并分析图片内容。当用户上传了图片并需要你理解图片内容时，调用此工具。' +
      '工具会使用视觉模型分析图片，返回图片的详细文字描述，包括场景、人物、物体、颜色、氛围等。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '图片文件的完整路径' },
        question: {
          type: 'string',
          description: '对图片的具体分析要求（可选，如"描述图片中的风景"）'
        }
      },
      required: ['file_path']
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { file_path?: unknown; question?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const filePath = typeof args.file_path === 'string' ? args.file_path : ''
  if (!filePath) {
    return JSON.stringify({ error: 'file_path is required' })
  }

  // Workspace containment guard — same boundary as the read tool.
  // Safe mode (or unrestricted with the secondary toggle off) always enforces
  // this check. Only unrestricted + explicit user opt-out skips it.
  if (isWorkspaceGuardEnabled()) {
    try {
      assertWithinWorkspace(filePath)
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Read image as base64 data URL
  let dataUrl: string
  try {
    dataUrl = readUploadAsDataUrl(filePath)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to read image file: ${msg}` })
  }

  // Get the multimodal model from settings
  const settings = readSettings()
  const model = settings.multimodal.find((m) => m.active)
  if (!model) {
    return JSON.stringify({ error: '未配置多模态模型，无法分析图片。请在设置中配置多模态模型。' })
  }

  const question =
    typeof args.question === 'string' && args.question
      ? args.question
      : '请详细描述这张图片的内容，包括场景、人物、物体、颜色、文字、氛围等所有细节。'

  const client = getOrCreateClient(model)

  try {
    const response = await client.chat.completions.create(
      {
        model: model.name,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: question },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ] as never,
        stream: false
      } as never,
      { signal: ctx.abortSignal }
    )

    const result = response as unknown as {
      choices: Array<{ message: { content: string | null } }>
    }
    const description = result.choices?.[0]?.message?.content ?? ''

    if (!description) {
      return JSON.stringify({ error: '视觉模型未返回任何内容' })
    }

    return JSON.stringify({ description, image_path: filePath })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `视觉模型调用失败: ${msg}` })
  }
}

export const visionTool: ToolDef = {
  name: 'vision',
  openai: TOOL_DEF,
  execute
}
