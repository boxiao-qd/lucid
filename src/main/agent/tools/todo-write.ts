// TodoWrite tool — creates and updates a structured task list.
// The model calls this to create/replace its task list. Each call fully replaces
// the current list; applyTodos diffs and emits plan_* events.

import type { ToolDef, ToolExecContext } from '../tool-def'
import type { TodoStatus } from '../../../shared/agent-events'
import { applyTodos, type TodoItem } from '../todo-store'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'TodoWrite',
    description:
      'Use this tool to create and manage your task list for the current session. ' +
      'Call this BEFORE starting work on complex tasks to create a plan, ' +
      'and update it each time you complete or start a task. ' +
      'Each call fully REPLACES the current todo list. ' +
      'Keep only ONE task in_progress at a time. ' +
      'Mark tasks completed IMMEDIATELY when done — never leave them in_progress after completion.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete new todo list. Fully replaces the existing list.',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description:
                  "Task in imperative form, e.g. 'Run unit tests', 'Analyze requirements'"
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current task status. Only ONE task may be in_progress at a time.'
              },
              activeForm: {
                type: 'string',
                description:
                  "Present-continuous form shown while running, e.g. 'Running unit tests'"
              },
              level: {
                type: 'integer',
                enum: [1, 2, 3],
                description: 'Hierarchy depth: 1=main step, 2=sub-step, 3=detail'
              }
            },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    }
  }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { todos?: unknown[] }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const todosRaw = args.todos
  if (!Array.isArray(todosRaw)) {
    return JSON.stringify({ error: 'todos must be an array' })
  }

  const validStatuses: TodoStatus[] = ['pending', 'in_progress', 'completed']
  const newTodos: TodoItem[] = []
  for (const t of todosRaw) {
    if (typeof t !== 'object' || t === null) continue
    const obj = t as { content?: unknown; status?: unknown; activeForm?: unknown; level?: unknown }
    if (typeof obj.content !== 'string' || !obj.content) continue
    if (typeof obj.status !== 'string') continue
    const status = validStatuses.includes(obj.status as TodoStatus)
      ? (obj.status as TodoStatus)
      : 'pending'
    const levelRaw = typeof obj.level === 'number' ? obj.level : 1
    const level = Math.max(1, Math.min(3, levelRaw))
    newTodos.push({
      content: obj.content,
      status,
      activeForm:
        typeof obj.activeForm === 'string' && obj.activeForm ? obj.activeForm : obj.content,
      level
    })
  }

  applyTodos(ctx.sessionId, newTodos, ctx.emit)

  return (
    'Todos have been updated. Continue using the todo list to track progress. ' +
    'Proceed with the current tasks.'
  )
}

export const todoWriteTool: ToolDef = {
  name: 'TodoWrite',
  openai: TOOL_DEF,
  execute
}
