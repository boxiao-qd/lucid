// schedule_task tool — lets the LLM create scheduled tasks via natural language.
// When the user says things like "每天下午3点帮我写一首诗", the LLM parses
// the intent and calls this tool with structured parameters: schedule type,
// cron expression, and payload. The tool creates the job via the scheduler
// service and returns the job details (including next run time).

import type { ToolDef } from '../tool-def'
import { addJob } from '../../scheduler/scheduler-service'
import { computeJobNextRunAtMs } from '../../scheduler/jobs'
import type { CronSchedule, CronPayload, CronJobCreate } from '../../scheduler/types'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'schedule_task',
    description:
      '创建定时任务。当用户提到"定时""每天""每小时""每隔""几点执行"等时间调度需求时，调用此工具。' +
      '你需要根据用户的自然语言描述，生成正确的 cron 表达式或时间参数。' +
      '当前时间在系统提示中提供，请据此计算绝对时间。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '任务名称，简洁描述任务目的，如"每日写诗"'
        },
        description: {
          type: 'string',
          description: '可选，任务详细描述'
        },
        schedule_type: {
          type: 'string',
          enum: ['at', 'every', 'cron'],
          description:
            '调度类型。at=一次性（指定某个时间点执行一次），every=周期（每隔N分钟重复），cron=cron表达式（最灵活，如"0 15 * * *"表示每天15:00）'
        },
        at_time: {
          type: 'string',
          description: '当 schedule_type=at 时必填。ISO 8601 格式时间，如 "2026-08-20T10:00:00"'
        },
        every_minutes: {
          type: 'number',
          description: '当 schedule_type=every 时必填。间隔分钟数，如 5 表示每5分钟'
        },
        cron_expr: {
          type: 'string',
          description:
            '当 schedule_type=cron 时必填。标准5字段cron表达式：分 时 日 月 周。' +
            '例如：*/5 * * * *（每5分钟）、0 15 * * *（每天15:00）、0 9 * * 1-5（工作日9:00）、0 0 * * 0（每周日0:00）'
        },
        payload_type: {
          type: 'string',
          enum: ['agentTurn', 'command', 'memoryConsolidate'],
          description:
            '任务类型。agentTurn=让AI执行对话任务，command=执行系统命令，memoryConsolidate=整理记忆'
        },
        message: {
          type: 'string',
          description: '当 payload_type=agentTurn 时必填。发送给AI的消息内容'
        },
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: '当 payload_type=command 时必填。命令及参数数组，如 ["echo", "hello"]'
        },
        cwd: {
          type: 'string',
          description: '当 payload_type=command 时可选。工作目录'
        },
        enabled: {
          type: 'boolean',
          description: '是否启用，默认 true'
        },
        delete_after_run: {
          type: 'boolean',
          description: '执行后是否删除任务（适用于一次性任务），默认 false'
        }
      },
      required: ['name', 'schedule_type', 'payload_type']
    }
  }
}

async function execute(argsStr: string): Promise<string> {
  let args: {
    name?: string
    description?: string
    schedule_type?: string
    at_time?: string
    every_minutes?: number
    cron_expr?: string
    payload_type?: string
    message?: string
    argv?: string[]
    cwd?: string
    enabled?: boolean
    delete_after_run?: boolean
  }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) return JSON.stringify({ error: 'name is required' })

  // Build schedule
  let schedule: CronSchedule
  switch (args.schedule_type) {
    case 'at': {
      const atTime = args.at_time
      if (!atTime) return JSON.stringify({ error: 'at_time is required when schedule_type=at' })
      const ms = new Date(atTime).getTime()
      if (isNaN(ms)) return JSON.stringify({ error: `Invalid at_time: ${atTime}` })
      schedule = { kind: 'at', at: new Date(ms).toISOString() }
      break
    }
    case 'every': {
      const mins = args.every_minutes
      if (!mins || mins <= 0)
        return JSON.stringify({ error: 'every_minutes must be a positive number' })
      schedule = { kind: 'every', everyMs: mins * 60_000 }
      break
    }
    case 'cron': {
      const expr = args.cron_expr?.trim()
      if (!expr) return JSON.stringify({ error: 'cron_expr is required when schedule_type=cron' })
      schedule = { kind: 'cron', expr }
      break
    }
    default:
      return JSON.stringify({ error: `Invalid schedule_type: ${args.schedule_type}` })
  }

  // Build payload
  let payload: CronPayload
  switch (args.payload_type) {
    case 'agentTurn': {
      const message = args.message?.trim()
      if (!message)
        return JSON.stringify({ error: 'message is required when payload_type=agentTurn' })
      payload = { kind: 'agentTurn', message }
      break
    }
    case 'command': {
      const argv = args.argv
      if (!argv || argv.length === 0)
        return JSON.stringify({ error: 'argv is required when payload_type=command' })
      payload = {
        kind: 'command',
        argv,
        ...(args.cwd?.trim() ? { cwd: args.cwd.trim() } : {})
      }
      break
    }
    case 'memoryConsolidate':
      payload = { kind: 'memoryConsolidate' }
      break
    default:
      return JSON.stringify({ error: `Invalid payload_type: ${args.payload_type}` })
  }

  // Build job input
  const input: CronJobCreate = {
    name,
    description: args.description?.trim() || undefined,
    enabled: args.enabled ?? true,
    deleteAfterRun: args.delete_after_run || undefined,
    schedule,
    payload
  }

  try {
    const job = addJob(input)
    const nextRunAtMs = computeJobNextRunAtMs(job, Date.now())
    const nextRunTime = nextRunAtMs ? new Date(nextRunAtMs).toLocaleString('zh-CN') : '—'
    return JSON.stringify({
      success: true,
      job_id: job.id,
      job_name: job.name,
      schedule: formatSchedule(schedule),
      payload_type: args.payload_type,
      next_run_time: nextRunTime
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to create task: ${msg}` })
  }
}

function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return `定时: ${new Date(schedule.at).toLocaleString('zh-CN')}`
    case 'every':
      return `每 ${Math.round(schedule.everyMs / 60000)} 分钟`
    case 'cron':
      return `Cron: ${schedule.expr}`
  }
}

export const scheduleTaskTool: ToolDef = {
  name: 'schedule_task',
  openai: TOOL_DEF,
  execute
}
