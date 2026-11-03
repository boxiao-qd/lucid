// get_current_time tool — returns the current date and time.
// No parameters needed. Provides formatted date, time, day of week,
// and timezone info to the LLM.

import type { ToolDef, ToolExecContext } from '../tool-def'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'get_current_time',
    description:
      '获取当前日期和时间。返回格式化的日期、时间、星期几和时区信息。' +
      '无需传任何参数。当你需要知道当前准确时间时调用此工具。',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
}

async function execute(_argsStr: string, _ctx: ToolExecContext): Promise<string> {
  const now = new Date()
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

  return JSON.stringify({
    date: now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: now.toLocaleTimeString('zh-CN', { hour12: false }),
    weekday: weekdays[now.getDay()],
    iso: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timestamp: now.getTime()
  })
}

export const getCurrentTimeTool: ToolDef = {
  name: 'get_current_time',
  openai: TOOL_DEF,
  execute
}
