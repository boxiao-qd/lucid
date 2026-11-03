// save_product tool — persists agent-generated artifacts (text, code, reports,
// poems, etc.) to disk under ~/.lucid/workspace/artifact/{sessionId}/product/.
// The agent calls this when it produces a deliverable that should be saved
// as a file rather than just printed in the chat.

import { saveProduct } from '../../uploads'
import type { ToolDef, ToolExecContext } from '../tool-def'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'save_product',
    description:
      '将产物（文字、代码、报告、诗歌等）保存为文件到当前会话的产物目录。' +
      '当你完成了任务并产出了可交付的内容时，可以调用此工具将其落盘保存。' +
      '返回保存的文件路径。',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description:
            '文件名，需包含扩展名。必须使用中文名字，如"每日诗歌.md"、"工作报告.txt"、"数据分析.json"、"会议纪要.md"'
        },
        content: {
          type: 'string',
          description: '要保存的完整文件内容'
        }
      },
      required: ['filename', 'content']
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { filename?: unknown; content?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const filename = typeof args.filename === 'string' ? args.filename.trim() : ''
  const content = typeof args.content === 'string' ? args.content : ''

  if (!filename) {
    return JSON.stringify({ error: 'filename is required' })
  }
  if (!content) {
    return JSON.stringify({ error: 'content is required' })
  }

  try {
    // When called from a sub-agent, save to the parent (main) session's
    // product directory so the file is visible in the main UI file list.
    // When runId is available (sub-agent execution), isolate in a
    // per-invocation subfolder so multiple expert invocations in the same
    // session don't overwrite each other.
    const productSessionId = ctx.parentSessionId ?? ctx.sessionId
    const filePath = saveProduct(productSessionId, content, filename, ctx.runId)
    return JSON.stringify({
      success: true,
      file_path: filePath,
      filename,
      size: content.length
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to save product: ${msg}` })
  }
}

export const saveProductTool: ToolDef = {
  name: 'save_product',
  openai: TOOL_DEF,
  execute
}
