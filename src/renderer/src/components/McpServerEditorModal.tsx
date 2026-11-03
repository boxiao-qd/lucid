// McpServerEditorModal — form for adding/editing MCP server configs.
// Fields: name (server key), command, args (space-separated), env (key=value lines).

import { useState, useEffect } from 'react'
import { useMcpStore } from '../store/mcpStore'
import type { McpServerConfig } from '@shared/types'

interface Props {
  open: boolean
  editName?: string | null // null = create mode, string = edit mode
  onClose: () => void
}

function McpServerEditorModal({ open, editName, onClose }: Props): React.JSX.Element | null {
  const addServer = useMcpStore((s) => s.addServer)
  const updateServer = useMcpStore((s) => s.updateServer)
  const config = useMcpStore((s) => s.config)

  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEdit = !!editName

  useEffect(() => {
    if (!open) return
    setError(null)
    if (editName && config.servers[editName]) {
      const server = config.servers[editName]
      setName(editName)
      setCommand(server.command)
      setArgs((server.args ?? []).join(' '))
      setEnv(
        Object.entries(server.env ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
      )
    } else {
      setName('')
      setCommand('')
      setArgs('')
      setEnv('')
    }
  }, [open, editName, config])

  if (!open) return null

  const parseEnv = (raw: string): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      if (key) result[key] = val
    }
    return result
  }

  const handleSave = async (): Promise<void> => {
    const trimmedName = name.trim()
    const trimmedCommand = command.trim()
    if (!trimmedName) {
      setError('请填写 Server 名称')
      return
    }
    if (!trimmedCommand) {
      setError('请填写命令')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const serverConfig: McpServerConfig = {
        command: trimmedCommand,
        args: args.trim() ? args.trim().split(/\s+/) : [],
        env: parseEnv(env)
      }

      if (isEdit && editName) {
        await updateServer(editName, serverConfig)
      } else {
        await addServer(trimmedName, serverConfig)
      }
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,90vw)] overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="text-sm font-medium text-stone-700">
            {isEdit ? '编辑 MCP Server' : '添加 MCP Server'}
          </span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
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

        {/* Form */}
        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">
              名称 <span className="text-red-400">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：notion"
              disabled={isEdit}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none disabled:bg-stone-100 disabled:text-stone-400"
            />
            {isEdit && <p className="mt-1 text-[10px] text-stone-400">编辑模式下名称不可修改</p>}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">
              命令 <span className="text-red-400">*</span>
            </label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="如：npx"
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">参数</label>
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="如：-y @notionhq/notion-mcp-server"
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
            />
            <p className="mt-1 text-[10px] text-stone-400">
              空格分隔，如：-y @notionhq/notion-mcp-server
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-stone-600">环境变量</label>
            <textarea
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder={
                'KEY=value\n每行一个，如：\nOPENAPI_MCP_HEADERS={"Authorization":"Bearer xxx"}'
              }
              rows={4}
              className="w-full resize-y rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-stone-200 px-3 py-1.5 text-xs text-stone-600 transition-colors hover:bg-stone-100"
          >
            取消
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-lg bg-stone-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default McpServerEditorModal
