// ScheduledTasks — cron job management page.
// Two tabs: "定时任务" (jobs CRUD) and "执行记录" (run history with
// result/file viewing).

import { useState, useEffect, useCallback } from 'react'
import { useUIStore } from '../store/uiStore'
import MarkdownRenderer from './MarkdownRenderer'
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronSchedule,
  CronPayload,
  CronRunRecord
} from '../../../main/scheduler/types'

function ScheduledTasks(): React.JSX.Element {
  const setView = useUIStore((s) => s.setView)
  const setFileHighlight = useUIStore((s) => s.setFileHighlight)
  const [tab, setTab] = useState<'jobs' | 'records'>('jobs')
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [records, setRecords] = useState<CronRunRecord[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingJob, setEditingJob] = useState<CronJob | null>(null)
  const [resultModal, setResultModal] = useState<{ title: string; text: string } | null>(null)

  const loadJobs = useCallback(async (): Promise<void> => {
    const list = await window.api.scheduler.list()
    setJobs(list)
  }, [])

  const loadRecords = useCallback(async (): Promise<void> => {
    const list = await window.api.scheduler.listRuns()
    setRecords(list)
  }, [])

  useEffect(() => {
    void loadJobs()
    void loadRecords()
    const interval = setInterval(() => {
      void loadJobs()
      void loadRecords()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadJobs, loadRecords])

  const handleAdd = (): void => {
    setEditingJob(null)
    setShowForm(true)
  }

  const handleEdit = (job: CronJob): void => {
    setEditingJob(job)
    setShowForm(true)
  }

  const handleDelete = async (id: string, name: string): Promise<void> => {
    if (confirm(`确定删除任务「${name}」？`)) {
      try {
        await window.api.scheduler.remove(id)
        await loadJobs()
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e))
      }
    }
  }

  const handleToggle = async (job: CronJob): Promise<void> => {
    try {
      await window.api.scheduler.update(job.id, { enabled: !job.enabled })
      await loadJobs()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  const handleRunNow = async (id: string): Promise<void> => {
    await window.api.scheduler.run(id)
    await loadJobs()
    await loadRecords()
  }

  const handleFormSubmit = async (data: CronJobCreate | CronJobPatch): Promise<void> => {
    if (editingJob) {
      await window.api.scheduler.update(editingJob.id, data as CronJobPatch)
    } else {
      await window.api.scheduler.add(data as CronJobCreate)
    }
    setShowForm(false)
    setEditingJob(null)
    await loadJobs()
  }

  const handleViewFile = (path: string): void => {
    setFileHighlight(path)
    setView('files')
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-stone-50">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('chat')}
            className="flex items-center gap-1 text-sm text-stone-500 transition-colors hover:text-stone-700"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            返回
          </button>
          <h1 className="text-lg font-bold text-stone-800">定时任务</h1>
        </div>
        {tab === 'jobs' && (
          <button
            onClick={handleAdd}
            className="flex items-center gap-1.5 rounded-lg bg-stone-800 px-3 py-1.5 text-sm text-white transition-colors hover:bg-stone-700"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            新建任务
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-stone-200 px-6">
        <button
          onClick={() => setTab('jobs')}
          className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            tab === 'jobs'
              ? 'border-stone-800 text-stone-800'
              : 'border-transparent text-stone-500 hover:text-stone-700'
          }`}
        >
          定时任务 {jobs.length > 0 && `(${jobs.length})`}
        </button>
        <button
          onClick={() => setTab('records')}
          className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            tab === 'records'
              ? 'border-stone-800 text-stone-800'
              : 'border-transparent text-stone-500 hover:text-stone-700'
          }`}
        >
          执行记录 {records.length > 0 && `(${records.length})`}
        </button>
      </div>

      {/* Content */}
      {tab === 'jobs' ? (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {jobs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-stone-400">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mb-3"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4l3 3" />
              </svg>
              <p className="text-sm">暂无定时任务</p>
              <p className="mt-1 text-xs">点击右上角「新建任务」创建，或在对话中用自然语言创建</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onRun={() => void handleRunNow(job.id)}
                  onEdit={() => handleEdit(job)}
                  onDelete={() => void handleDelete(job.id, job.name)}
                  onToggle={() => void handleToggle(job)}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {records.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-stone-400">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mb-3"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <p className="text-sm">暂无执行记录</p>
              <p className="mt-1 text-xs">定时任务执行后将在此显示记录</p>
            </div>
          ) : (
            <GroupedRecordsList
              records={records}
              onViewResult={setResultModal}
              onViewFile={handleViewFile}
            />
          )}
        </div>
      )}

      {showForm && (
        <JobFormModal
          job={editingJob}
          onClose={() => {
            setShowForm(false)
            setEditingJob(null)
          }}
          onSubmit={handleFormSubmit}
        />
      )}

      {resultModal && (
        <ResultModal
          title={resultModal.title}
          text={resultModal.text}
          onClose={() => setResultModal(null)}
        />
      )}
    </div>
  )
}

// ── Job Card ──

function JobCard({
  job,
  onRun,
  onEdit,
  onDelete,
  onToggle
}: {
  job: CronJob
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}): React.JSX.Element {
  const scheduleText = formatSchedule(job.schedule)
  const payloadText = formatPayload(job.payload)
  const nextRun = job.state.nextRunAtMs ? formatTime(job.state.nextRunAtMs) : '—'
  const lastRun = job.state.lastRunAtMs ? formatTime(job.state.lastRunAtMs) : '—'
  const lastStatus = job.state.lastRunStatus
  const isRunning = !!job.state.runningAtMs
  const isSystem = job.ownerType === 'system'

  return (
    <div className="flex flex-col rounded-xl border border-stone-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      {/* Top: name + status */}
      <div className="flex items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-stone-800">{job.name}</span>
            {isSystem && (
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
                系统
              </span>
            )}
            {job.deleteAfterRun && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-600">
                一次性
              </span>
            )}
          </div>
          <div className="mt-0.5">
            {isRunning ? (
              <span className="inline-flex items-center gap-1 text-xs text-blue-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                运行中
              </span>
            ) : job.enabled ? (
              <span className="inline-flex items-center gap-1 text-xs text-green-600">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                {payloadText}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-stone-400">
                <span className="h-1.5 w-1.5 rounded-full bg-stone-300" />
                已禁用
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Middle: schedule details */}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="rounded-md bg-stone-50 px-3 py-2">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-stone-400">调度</div>
          <div className="font-mono text-xs text-stone-600">{scheduleText}</div>
        </div>
        {job.description && (
          <p className="line-clamp-2 text-xs leading-relaxed text-stone-500">{job.description}</p>
        )}
        <div className="flex items-center gap-4 text-xs text-stone-500">
          <span>
            <span className="text-stone-400">下次</span> {nextRun}
          </span>
          <span>
            <span className="text-stone-400">上次</span> {lastRun}
            {lastStatus && (
              <span
                className={`ml-1 ${
                  lastStatus === 'ok'
                    ? 'text-green-600'
                    : lastStatus === 'error'
                      ? 'text-red-600'
                      : 'text-stone-400'
                }`}
              >
                ({lastStatus === 'ok' ? '成功' : lastStatus === 'error' ? '失败' : '跳过'})
              </span>
            )}
          </span>
        </div>
        {job.state.consecutiveErrors > 0 && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-500">
            连续错误: {job.state.consecutiveErrors}
          </div>
        )}
      </div>

      {/* Bottom: action buttons */}
      <div className="flex items-center gap-1 border-t border-stone-100 p-4">
        {/* Enabled toggle — disabled for system jobs */}
        <button
          onClick={onToggle}
          disabled={isSystem}
          className={`relative h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            job.enabled ? 'bg-stone-800' : 'bg-stone-300'
          }`}
          title={isSystem ? '系统任务不可禁用' : job.enabled ? '已启用' : '已禁用'}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              job.enabled ? 'left-4' : 'left-0.5'
            }`}
          />
        </button>
        <div className="flex-1" />
        {/* Run now */}
        <button
          onClick={onRun}
          disabled={isRunning}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-50"
          title="立即运行"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          运行
        </button>
        {/* Edit */}
        <button
          onClick={onEdit}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
          title="编辑"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          编辑
        </button>
        {/* Delete — hidden for system jobs */}
        {!isSystem && (
          <button
            onClick={onDelete}
            className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-red-500"
            title="删除"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

// ── Job Form Modal ──

function JobFormModal({
  job,
  onClose,
  onSubmit
}: {
  job: CronJob | null
  onClose: () => void
  onSubmit: (data: CronJobCreate | CronJobPatch) => Promise<void>
}): React.JSX.Element {
  const isEdit = !!job
  const [name, setName] = useState(job?.name ?? '')
  const [description, setDescription] = useState(job?.description ?? '')
  const [enabled, setEnabled] = useState(job?.enabled ?? true)
  const [deleteAfterRun, setDeleteAfterRun] = useState(job?.deleteAfterRun ?? false)

  // Schedule state
  const [scheduleKind, setScheduleKind] = useState<'at' | 'every' | 'cron'>(
    job?.schedule.kind ?? 'cron'
  )
  const [atTime, setAtTime] = useState(
    job?.schedule?.kind === 'at' ? job.schedule.at.slice(0, 16) : ''
  )
  const [everyMs, setEveryMs] = useState(
    job?.schedule?.kind === 'every' ? String(Math.round(job.schedule.everyMs / 60000)) : '5'
  )
  const [cronExpr, setCronExpr] = useState(
    job?.schedule?.kind === 'cron' ? job.schedule.expr : '*/5 * * * *'
  )

  // Payload state
  const [payloadKind, setPayloadKind] = useState<'agentTurn' | 'command' | 'memoryConsolidate'>(
    job?.payload.kind ?? 'agentTurn'
  )
  const [agentMessage, setAgentMessage] = useState(
    job?.payload?.kind === 'agentTurn' ? job.payload.message : ''
  )
  const [commandArgv, setCommandArgv] = useState(
    job?.payload?.kind === 'command' ? job.payload.argv.join(' ') : ''
  )
  const [commandCwd, setCommandCwd] = useState(
    job?.payload?.kind === 'command' ? (job.payload.cwd ?? '') : ''
  )

  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (): Promise<void> => {
    if (!name.trim()) {
      alert('请输入任务名称')
      return
    }

    // Build schedule
    let schedule: CronSchedule
    if (scheduleKind === 'at') {
      if (!atTime) {
        alert('请输入执行时间')
        return
      }
      schedule = { kind: 'at', at: new Date(atTime).toISOString() }
    } else if (scheduleKind === 'every') {
      const ms = parseInt(everyMs, 10)
      if (!ms || ms <= 0) {
        alert('请输入有效的间隔分钟数')
        return
      }
      schedule = { kind: 'every', everyMs: ms * 60_000 }
    } else {
      if (!cronExpr.trim()) {
        alert('请输入 Cron 表达式')
        return
      }
      schedule = { kind: 'cron', expr: cronExpr.trim() }
    }

    // Build payload
    let payload: CronPayload
    if (payloadKind === 'agentTurn') {
      if (!agentMessage.trim()) {
        alert('请输入 Agent 消息')
        return
      }
      payload = { kind: 'agentTurn', message: agentMessage.trim() }
    } else if (payloadKind === 'command') {
      const argv = commandArgv.trim().split(/\s+/).filter(Boolean)
      if (argv.length === 0) {
        alert('请输入命令')
        return
      }
      payload = {
        kind: 'command',
        argv,
        ...(commandCwd.trim() ? { cwd: commandCwd.trim() } : {})
      }
    } else {
      payload = { kind: 'memoryConsolidate' }
    }

    setSubmitting(true)
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        enabled,
        deleteAfterRun: deleteAfterRun || undefined,
        schedule,
        payload
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-stone-800">
            {isEdit ? '编辑任务' : '新建定时任务'}
          </h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="任务名称"
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">描述</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选描述"
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
            />
          </div>

          {/* Schedule type */}
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">调度类型</label>
            <div className="flex gap-4">
              {(['at', 'every', 'cron'] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm text-stone-600">
                  <input
                    type="radio"
                    name="scheduleKind"
                    checked={scheduleKind === k}
                    onChange={() => setScheduleKind(k)}
                  />
                  {k === 'at' ? '一次性' : k === 'every' ? '周期' : 'Cron'}
                </label>
              ))}
            </div>
          </div>

          {/* Schedule-specific inputs */}
          {scheduleKind === 'at' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-stone-700">执行时间</label>
              <input
                type="datetime-local"
                value={atTime}
                onChange={(e) => setAtTime(e.target.value)}
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
              />
            </div>
          )}
          {scheduleKind === 'every' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-stone-700">间隔（分钟）</label>
              <input
                type="number"
                min="1"
                value={everyMs}
                onChange={(e) => setEveryMs(e.target.value)}
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
              />
            </div>
          )}
          {scheduleKind === 'cron' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-stone-700">Cron 表达式</label>
              <input
                type="text"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="*/5 * * * *"
                className="w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-sm outline-none focus:border-stone-500"
              />
              <p className="mt-1 text-xs text-stone-400">
                格式：分 时 日 月 周（例如 */5 * * * * 每5分钟）
              </p>
            </div>
          )}

          {/* Payload type */}
          <div>
            <label className="mb-1 block text-sm font-medium text-stone-700">任务类型</label>
            <div className="flex gap-4">
              {(['agentTurn', 'command', 'memoryConsolidate'] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm text-stone-600">
                  <input
                    type="radio"
                    name="payloadKind"
                    checked={payloadKind === k}
                    onChange={() => setPayloadKind(k)}
                  />
                  {k === 'agentTurn' ? 'Agent对话' : k === 'command' ? '命令' : '记忆整理'}
                </label>
              ))}
            </div>
          </div>

          {/* Payload-specific inputs */}
          {payloadKind === 'agentTurn' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-stone-700">消息内容</label>
              <textarea
                value={agentMessage}
                onChange={(e) => setAgentMessage(e.target.value)}
                placeholder="发送给 Agent 的消息"
                rows={3}
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
              />
            </div>
          )}
          {payloadKind === 'command' && (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium text-stone-700">命令</label>
                <input
                  type="text"
                  value={commandArgv}
                  onChange={(e) => setCommandArgv(e.target.value)}
                  placeholder="例如：echo hello"
                  className="w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-sm outline-none focus:border-stone-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-stone-700">
                  工作目录（可选）
                </label>
                <input
                  type="text"
                  value={commandCwd}
                  onChange={(e) => setCommandCwd(e.target.value)}
                  placeholder="/path/to/dir"
                  className="w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-sm outline-none focus:border-stone-500"
                />
              </div>
            </>
          )}
          {payloadKind === 'memoryConsolidate' && (
            <p className="text-sm text-stone-400">记忆整理任务无需额外参数</p>
          )}

          {/* Toggles */}
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              启用
            </label>
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input
                type="checkbox"
                checked={deleteAfterRun}
                onChange={(e) => setDeleteAfterRun(e.target.checked)}
              />
              执行后删除
            </label>
          </div>
        </div>

        {/* Buttons */}
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-stone-300 px-4 py-2 text-sm text-stone-600 transition-colors hover:bg-stone-100"
          >
            取消
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-md bg-stone-800 px-4 py-2 text-sm text-white transition-colors hover:bg-stone-700 disabled:opacity-50"
          >
            {submitting ? '提交中…' : isEdit ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Grouped Records List (by job) ──

interface RecordGroup {
  jobId: string
  jobName: string
  records: CronRunRecord[]
}

function GroupedRecordsList({
  records,
  onViewResult,
  onViewFile
}: {
  records: CronRunRecord[]
  onViewResult: (modal: { title: string; text: string }) => void
  onViewFile: (path: string) => void
}): React.JSX.Element {
  // Group by jobId, sort each group by startedAtMs desc, sort groups by latest record desc
  const groups: RecordGroup[] = (() => {
    const map = new Map<string, CronRunRecord[]>()
    for (const record of records) {
      const list = map.get(record.jobId) ?? []
      list.push(record)
      map.set(record.jobId, list)
    }
    const result: RecordGroup[] = []
    for (const [jobId, recs] of map) {
      recs.sort((a, b) => b.startedAtMs - a.startedAtMs)
      result.push({ jobId, jobName: recs[0].jobName, records: recs })
    }
    result.sort((a, b) => b.records[0].startedAtMs - a.records[0].startedAtMs)
    return result
  })()

  // Default: expand the first (latest) group
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([groups[0]?.jobId]))

  const toggleGroup = (jobId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(jobId)) {
        next.delete(jobId)
      } else {
        next.add(jobId)
      }
      return next
    })
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const isExpanded = expanded.has(group.jobId)
        const latest = group.records[0]
        return (
          <div
            key={group.jobId}
            className="overflow-hidden rounded-lg border border-stone-300 shadow-sm"
          >
            {/* Group header — distinct bar */}
            <button
              onClick={() => toggleGroup(group.jobId)}
              className="flex w-full items-center gap-2.5 bg-stone-100 px-4 py-2.5 text-left transition-colors hover:bg-stone-200/70"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`flex-shrink-0 text-stone-500 transition-transform ${
                  isExpanded ? 'rotate-90' : ''
                }`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${
                  latest.status === 'ok'
                    ? 'bg-green-500'
                    : latest.status === 'error'
                      ? 'bg-red-500'
                      : 'bg-stone-400'
                }`}
              />
              <span className="flex-shrink-0 text-sm font-semibold text-stone-800">
                {group.jobName}
              </span>
              <span className="flex-shrink-0 rounded-full bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-600">
                {group.records.length} 条
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-stone-400">
                最近 {formatRecordTime(latest.startedAtMs)}
              </span>
            </button>
            {/* Group records — flat rows */}
            {isExpanded && (
              <div className="divide-y divide-stone-100">
                {group.records.map((record) => (
                  <RunRecordCard
                    key={record.id}
                    record={record}
                    onViewResult={(text) =>
                      onViewResult({ title: record.jobName + ' — 执行结果', text })
                    }
                    onViewFile={onViewFile}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Run Record Card ──

function RunRecordCard({
  record,
  onViewResult,
  onViewFile
}: {
  record: CronRunRecord
  onViewResult: (text: string) => void
  onViewFile: (path: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-stone-50">
      {/* Status dot */}
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
          record.status === 'ok'
            ? 'bg-green-500'
            : record.status === 'error'
              ? 'bg-red-500'
              : 'bg-stone-300'
        }`}
      />

      {/* Execution time */}
      <span className="flex-shrink-0 font-mono text-xs text-stone-500">
        {formatRecordTime(record.startedAtMs)}
      </span>

      {/* Duration */}
      <span className="flex-shrink-0 text-xs text-stone-400">
        {(record.durationMs / 1000).toFixed(1)}s
      </span>

      {/* Error info */}
      {record.exitCode !== undefined && record.exitCode !== 0 && (
        <span className="flex-shrink-0 text-xs text-red-500">退出码 {record.exitCode}</span>
      )}
      {record.error && (
        <span className="min-w-0 flex-1 truncate text-xs text-red-400">{record.error}</span>
      )}

      {/* Spacer if no error */}
      {!record.error && <div className="flex-1" />}

      {/* Right: action buttons */}
      <div className="flex flex-shrink-0 items-center gap-2">
        {record.resultText && (
          <button
            onClick={() => onViewResult(record.resultText!)}
            className="flex items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-600 transition-colors hover:bg-stone-100"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            查看结果
          </button>
        )}
        {record.productFiles &&
          record.productFiles.length > 0 &&
          record.productFiles.map((filePath) => {
            const fileName = filePath.split('/').pop() || filePath
            return (
              <button
                key={filePath}
                onClick={() => onViewFile(filePath)}
                className="flex items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-600 transition-colors hover:bg-stone-100"
                title={filePath}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                {fileName.length > 20 ? fileName.slice(0, 17) + '…' : fileName}
              </button>
            )
          })}
      </div>
    </div>
  )
}

// ── Result Modal ──

function ResultModal({
  title,
  text,
  onClose
}: {
  title: string
  text: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(640px,90vw)] flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="truncate text-sm font-medium text-stone-700">{title}</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label="关闭"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <MarkdownRenderer content={text} />
        </div>
      </div>
    </div>
  )
}

// ── Helpers ──

function formatRecordTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const now = Date.now()
  const diff = ms - now
  const absDiff = Math.abs(diff)

  if (absDiff < 60_000) return diff > 0 ? '即将' : '刚刚'
  if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000)
    return diff > 0 ? `${mins}分钟后` : `${mins}分钟前`
  }

  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const mins = String(d.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${mins}`
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

function formatPayload(payload: CronPayload): string {
  switch (payload.kind) {
    case 'agentTurn':
      return 'Agent对话'
    case 'command':
      return `命令: ${payload.argv.join(' ')}`
    case 'memoryConsolidate':
      return '记忆整理'
  }
}

export default ScheduledTasks
