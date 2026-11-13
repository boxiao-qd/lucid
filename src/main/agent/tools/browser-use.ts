// browser_use tool — lets the agent control a built-in browser via CDP.
// The browser panel opens automatically on first call. Screenshots are
// returned as image content blocks to the LLM (handled by agent-runner).

import type { ToolDef, ToolExecContext } from '../tool-def'
import type { BrowserCommand, BrowserCommandResult } from '../../../shared/browser-use'
import { BROWSER_COMMAND_METHODS } from '../../../shared/browser-use'
import { browserGuestManager } from '../../browser-use/guest-manager'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'browser_use',
    description:
      '控制内置浏览器：导航、截图、DOM 快照、点击、输入、按键、滚动等。' +
      '首次调用时浏览器面板自动打开。每次调用必须传 purpose 字段（一句话说明本次操作目的）。' +
      '导航后务必调用 snapshot 或 screenshot 查看页面内容。' +
      'snapshot 返回可交互元素列表及 ref 句柄，后续 click/type/select 等操作用 ref 定位元素。' +
      '截图结果会以图片形式返回给你查看。',
    parameters: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          description: '一句话说明本次浏览器操作的目的（如：打开登录页、点击搜索按钮、截图查看结果）'
        },
        command: {
          type: 'object',
          description:
            'Browser command to execute. The "method" field determines the command type. ' +
            'Common flow: navigate → snapshot (get refs) or screenshot (see page) → click/type (using ref).',
          properties: {
            method: {
              type: 'string',
              enum: [...BROWSER_COMMAND_METHODS],
              description:
                'Command method. navigate(url), back, forward, reload, ' +
                'screenshot(fullPage?,clip?), snapshot(maxElements?), ' +
                'click(ref?|x,y), type(ref?,text), press(key,ref?), scroll(ref?|x,y), ' +
                'hover(ref?|x,y), select(ref,values), check(ref,checked?), ' +
                'getState, evaluate(expression), elementInfo(x,y), close'
            },
            url: { type: 'string', description: 'Target URL for navigate' },
            ref: {
              type: 'string',
              description:
                'Element ref from snapshot (for click/type/scroll/hover/select/check/press)'
            },
            text: { type: 'string', description: 'Text to type (for type command)' },
            key: {
              type: 'string',
              description: 'Key to press (for press command, e.g. Enter, Tab)'
            },
            x: {
              type: 'number',
              description: 'Viewport X coordinate (for click/hover/scroll/elementInfo)'
            },
            y: {
              type: 'number',
              description: 'Viewport Y coordinate (for click/hover/scroll/elementInfo)'
            },
            values: {
              type: 'array',
              items: { type: 'string' },
              description: 'Values to select (for select command)'
            },
            checked: {
              type: 'boolean',
              description: 'Checked state (for check command, default true)'
            },
            fullPage: { type: 'boolean', description: 'Capture full page (for screenshot)' },
            maxElements: { type: 'number', description: 'Max elements in snapshot (default 200)' },
            expression: { type: 'string', description: 'JS expression to evaluate (for evaluate)' }
          },
          required: ['method']
        }
      },
      required: ['command']
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { command?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({
      ok: false,
      error: { code: 'execution_error', message: 'Invalid JSON arguments' }
    })
  }

  const command = args.command as BrowserCommand | undefined
  if (!command || typeof command !== 'object' || typeof command.method !== 'string') {
    return JSON.stringify({
      ok: false,
      error: { code: 'execution_error', message: 'command.method is required' }
    })
  }

  if (
    !BROWSER_COMMAND_METHODS.includes(command.method as (typeof BROWSER_COMMAND_METHODS)[number])
  ) {
    return JSON.stringify({
      ok: false,
      error: { code: 'capability_unsupported', message: `Unknown method: ${command.method}` }
    })
  }

  try {
    console.log(`[browser_use tool] executing: method=${(command as { method: string }).method}`)
    const result: BrowserCommandResult = await browserGuestManager.execute(
      ctx.sessionId,
      command as BrowserCommand,
      ctx.abortSignal,
      ctx.emit
    )
    console.log(
      `[browser_use tool] result: ok=${result.ok} method=${(command as { method: string }).method}`,
      result.error ? `error=${result.error.code}: ${result.error.message}` : ''
    )
    return JSON.stringify(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const cancelled = ctx.abortSignal.aborted || (e instanceof Error && e.name === 'AbortError')
    return JSON.stringify({
      ok: false,
      error: {
        code: cancelled ? 'cancelled' : 'renderer_unreachable',
        message: cancelled ? 'Browser command cancelled' : message
      },
      elapsedMs: 0
    })
  }
}

export const browserUseTool: ToolDef = {
  name: 'browser_use',
  openai: TOOL_DEF,
  execute
}
