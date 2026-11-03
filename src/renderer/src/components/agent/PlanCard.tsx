// PlanCard — displays agent plan steps, adapted to lucid stone palette.
// Shows the agent's todo list with ○ ◉ ● status icons, level indentation,
// activeForm display, and a progress bar for top-level steps.

import { useAgentStore, type PlanState } from '../../store/agentStore'
import type { PlanStep } from '../../../../shared/agent-events'

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◉',
  completed: '●'
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  in_progress: '执行中',
  completed: '已完成'
}

function StepRow({ step }: { step: PlanStep }): React.JSX.Element {
  const indent = '  '.repeat(Math.max(0, step.level - 1))
  const isCompleted = step.status === 'completed'
  const isInProgress = step.status === 'in_progress'

  const textClass = isCompleted
    ? 'text-stone-400'
    : isInProgress
      ? 'text-stone-900 font-medium'
      : 'text-stone-500'

  const activeForm = isInProgress && step.activeForm ? ` — ${step.activeForm}` : ''

  return (
    <div className={`flex items-start gap-2 py-0.5 text-sm ${textClass}`}>
      <span className="select-none whitespace-pre">{indent}</span>
      {isCompleted ? (
        <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-stone-800 text-[10px] leading-none text-white">
          ✓
        </span>
      ) : (
        <span className="select-none">{STATUS_ICON[step.status]}</span>
      )}
      <span className="flex-1">
        {step.content}
        {!isCompleted && (
          <span className="ml-2 text-xs text-stone-400">{STATUS_LABEL[step.status]}</span>
        )}
        {activeForm && <span className="text-stone-500">{activeForm}</span>}
      </span>
    </div>
  )
}

function ProgressBar({ steps }: { steps: PlanStep[] }): React.JSX.Element {
  const topLevel = steps.filter((s) => s.level === 1)
  if (topLevel.length === 0) return <></>
  const completed = topLevel.filter((s) => s.status === 'completed').length
  const pct = Math.round((completed / topLevel.length) * 100)

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-xs text-stone-500">
        <span>进度</span>
        <span>
          {completed}/{topLevel.length} ({pct}%)
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-stone-200">
        <div
          className="h-1.5 rounded-full bg-stone-700 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function PlanCard(): React.JSX.Element {
  const plan = useAgentStore((s) => s.plan)
  if (!plan) return <></>

  const planState: PlanState = plan
  const isDone = planState.status === 'completed'

  return (
    <div className="w-full rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-stone-500">执行计划</span>
        {isDone && (
          <span className="rounded bg-stone-700 px-2 py-0.5 text-xs text-white">DONE</span>
        )}
      </div>
      <ProgressBar steps={planState.steps} />
      <div className="space-y-0.5">
        {planState.steps.map((step, i) => (
          <StepRow key={`${step.id}-${i}`} step={step} />
        ))}
      </div>
    </div>
  )
}

export default PlanCard
