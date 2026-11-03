// TodoWrite state + diff/emit — diff tracking and event emission.
// In-memory per-session todo list. Each TodoWrite call fully REPLACES the list;
// applyTodos diffs old vs new (by MD5(content) id) and emits plan_* events.

import { createHash } from 'node:crypto'
import type { PlanStep, TodoStatus } from '../../shared/agent-events'
import type { Emit } from './event-bus'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
  level: number
}

const _SESSION_TODOS = new Map<string, TodoItem[]>()

export function getTodos(sessionId: string): TodoItem[] {
  return _SESSION_TODOS.get(sessionId) ?? []
}

export function clearTodos(sessionId: string): void {
  _SESSION_TODOS.delete(sessionId)
}

// MD5(content) first 10 chars — stable id across calls so status changes are detectable.
export function makeId(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 10)
}

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◉',
  completed: '●'
}
const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: '待执行',
  in_progress: '执行中',
  completed: '已完成'
}

// Compact progress string injected into the LLM system message each iteration.
export function todoSummaryForLlm(sessionId: string): string {
  const todos = _SESSION_TODOS.get(sessionId)
  if (!todos || todos.length === 0) return ''

  const lines = ['[当前任务进度]']
  for (const t of todos) {
    const icon = STATUS_ICON[t.status]
    const label = STATUS_LABEL[t.status]
    const indent = '  '.repeat(Math.max(0, t.level - 1))
    const active = t.status === 'in_progress' && t.activeForm ? ` — ${t.activeForm}` : ''
    lines.push(`  ${indent}${icon} ${t.content} (${label})${active}`)
  }
  return lines.join('\n')
}

export function getAllCompleted(sessionId: string): boolean {
  const todos = _SESSION_TODOS.get(sessionId)
  if (!todos || todos.length === 0) return false
  return todos.every((t) => t.status === 'completed')
}

function toSteps(todos: TodoItem[]): PlanStep[] {
  return todos.map((t) => ({
    id: makeId(t.content),
    content: t.content,
    status: t.status,
    level: t.level,
    activeForm: t.activeForm || ''
  }))
}

// Core diff/emit (port of _diff_and_emit). Compares old vs new todos by content-id,
// emits plan_created/plan_adjusted + per-step start/complete + plan_complete.
export function applyTodos(sessionId: string, newTodos: TodoItem[], emit: Emit): void {
  const oldTodos = _SESSION_TODOS.get(sessionId) ?? []
  const steps = toSteps(newTodos)

  // Store new state
  _SESSION_TODOS.set(sessionId, newTodos)

  if (oldTodos.length === 0) {
    emit('plan_created', { plan_id: sessionId, steps })
  } else {
    emit('plan_adjusted', { plan_id: sessionId, steps })
  }

  // Per-step status transition events
  const oldById = new Map(oldTodos.map((t) => [makeId(t.content), t] as const))
  for (let i = 0; i < newTodos.length; i++) {
    const newT = newTodos[i]
    const tid = makeId(newT.content)
    const oldT = oldById.get(tid)
    const oldStatus: TodoStatus = oldT ? oldT.status : 'pending'
    const newStatus = newT.status

    if (newStatus === 'in_progress' && oldStatus !== 'in_progress') {
      emit('plan_step_start', {
        plan_id: sessionId,
        step_index: i,
        activeForm: newT.activeForm || newT.content
      })
    } else if (newStatus === 'completed' && oldStatus !== 'completed') {
      emit('plan_step_complete', { plan_id: sessionId, step_index: i })
    }
  }

  // All completed → plan_complete
  if (newTodos.length > 0 && newTodos.every((t) => t.status === 'completed')) {
    emit('plan_complete', { plan_id: sessionId, summary: '所有任务已完成' })
  }
}

// Auto-complete remaining pending/in_progress todos when the LLM gives a final
// answer without marking everything done. Returns true if any were completed.
export function forceCompleteTodos(sessionId: string, emit: Emit): boolean {
  const todos = _SESSION_TODOS.get(sessionId)
  if (!todos || todos.length === 0) return false
  if (todos.every((t) => t.status === 'completed')) return false

  const completed = todos.map((t) => ({ ...t, status: 'completed' as TodoStatus }))
  applyTodos(sessionId, completed, emit)
  return true
}
