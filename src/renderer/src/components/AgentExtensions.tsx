// AgentExtensions — extensions management page with MCP / A2A tabs.
// MCP tab: list configured MCP servers, test connection, add/edit/delete.
// A2A tab: placeholder for future agent-to-agent communication.

import { useState, useEffect, useCallback } from 'react'
import { useMcpStore } from '../store/mcpStore'
import { useUIStore } from '../store/uiStore'
import McpServerEditorModal from './McpServerEditorModal'

type Tab = 'mcp' | 'a2a'

function AgentExtensions(): React.JSX.Element {
  const config = useMcpStore((s) => s.config)
  const serverInfos = useMcpStore((s) => s.serverInfos)
  const load = useMcpStore((s) => s.load)
  const deleteServer = useMcpStore((s) => s.deleteServer)
  const testServer = useMcpStore((s) => s.testServer)
  const setView = useUIStore((s) => s.setView)

  const [tab, setTab] = useState<Tab>('mcp')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editName, setEditName] = useState<string | null>(null)
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set())

  useEffect(() => {
    void load()
  }, [load])

  const toggleExpand = useCallback((name: string): void => {
    setExpandedServers((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const handleAdd = (): void => {
    setEditName(null)
    setEditorOpen(true)
  }

  const handleEdit = (name: string): void => {
    setEditName(name)
    setEditorOpen(true)
  }

  const handleDelete = async (name: string): Promise<void> => {
    if (confirm(`确定删除 MCP Server「${name}」？`)) {
      await deleteServer(name)
    }
  }

  const handleTest = async (name: string): Promise<void> => {
    await testServer(name)
    setExpandedServers((prev) => new Set(prev).add(name))
  }

  const serverEntries = Object.entries(config.servers)

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
          <h1 className="text-lg font-bold text-stone-800">智能体扩展</h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-stone-200 px-6">
        <button
          onClick={() => setTab('mcp')}
          className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === 'mcp'
              ? 'border-stone-800 text-stone-800'
              : 'border-transparent text-stone-400 hover:text-stone-600'
          }`}
        >
          MCP
        </button>
        <button
          onClick={() => setTab('a2a')}
          className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            tab === 'a2a'
              ? 'border-stone-800 text-stone-800'
              : 'border-transparent text-stone-400 hover:text-stone-600'
          }`}
        >
          A2A
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'mcp' ? (
          <div>
            {/* MCP toolbar */}
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-stone-500">
                配置 MCP Server，让智能体具备外部工具调用能力
              </p>
              <button
                onClick={handleAdd}
                className="flex items-center gap-1.5 rounded-lg bg-stone-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-stone-800"
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
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                添加 MCP Server
              </button>
            </div>

            {/* Server list */}
            {serverEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-stone-400">
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
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <p className="text-sm">暂无 MCP Server</p>
                <p className="mt-1 text-xs">点击"添加 MCP Server"配置</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {serverEntries.map(([name, serverConfig]) => {
                  const info = serverInfos[name]
                  const status = info?.status ?? 'idle'
                  const expanded = expandedServers.has(name)
                  const commandStr =
                    `${serverConfig.command} ${(serverConfig.args ?? []).join(' ')}`.trim()

                  return (
                    <div
                      key={name}
                      className="flex flex-col rounded-xl border border-stone-200 bg-white shadow-sm transition-shadow hover:shadow-md"
                    >
                      {/* Top: icon + name + status */}
                      <div className="flex items-center gap-3 p-4">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-stone-100">
                          <svg
                            className="h-5 w-5 text-stone-500"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M5 7h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2zM7 7V5a2 2 0 012-2h6a2 2 0 012 2v2"
                            />
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-stone-800">
                              {name}
                            </span>
                          </div>
                          <div className="mt-0.5">
                            {status === 'connected' && (
                              <span className="inline-flex items-center gap-1 text-xs text-green-600">
                                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                                已连接
                              </span>
                            )}
                            {status === 'testing' && (
                              <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                                测试中...
                              </span>
                            )}
                            {status === 'error' && (
                              <span className="inline-flex items-center gap-1 text-xs text-red-500">
                                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                                连接失败
                              </span>
                            )}
                            {status === 'idle' && (
                              <span className="inline-flex items-center gap-1 text-xs text-stone-400">
                                <span className="h-1.5 w-1.5 rounded-full bg-stone-300" />
                                未连接
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Middle: command + tool count */}
                      <div className="flex flex-1 flex-col gap-2 p-4">
                        <div className="rounded-md bg-stone-50 px-3 py-2">
                          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-stone-400">
                            命令
                          </div>
                          <div className="truncate font-mono text-xs text-stone-600">
                            {commandStr}
                          </div>
                        </div>
                        {info && info.tools.length > 0 && (
                          <div className="flex items-center gap-2 text-xs text-stone-500">
                            <svg
                              className="h-3.5 w-3.5 text-stone-400"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.5}
                                d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
                              />
                            </svg>
                            <span>{info.tools.length} 个工具</span>
                          </div>
                        )}
                        {info?.error && (
                          <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-500">
                            {info.error}
                          </div>
                        )}
                      </div>

                      {/* Bottom: action buttons */}
                      <div className="flex items-center gap-1 border-t border-stone-100 p-4">
                        <button
                          onClick={() => void handleTest(name)}
                          disabled={status === 'testing'}
                          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-50"
                          title="测试连接"
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
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                          </svg>
                          测试
                        </button>
                        <button
                          onClick={() => handleEdit(name)}
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
                        <div className="flex-1" />
                        {info && info.tools.length > 0 && (
                          <button
                            onClick={() => toggleExpand(name)}
                            className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
                            title={expanded ? '收起工具' : '展开工具'}
                          >
                            工具
                            <svg
                              className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                          </button>
                        )}
                        <button
                          onClick={() => void handleDelete(name)}
                          className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500"
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
                      </div>

                      {/* Tools list (expanded) */}
                      {expanded && info && info.tools.length > 0 && (
                        <div className="border-t border-stone-100 p-4">
                          <div className="space-y-1.5">
                            {info.tools.map((tool) => (
                              <div
                                key={tool.name}
                                className="flex flex-col gap-0.5 rounded-md bg-stone-50 px-3 py-2"
                              >
                                <span className="font-mono text-xs font-medium text-stone-700">
                                  {tool.name}
                                </span>
                                {tool.description && (
                                  <p className="text-[11px] leading-relaxed text-stone-400">
                                    {tool.description}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          /* A2A tab placeholder */
          <div className="flex flex-col items-center justify-center py-16 text-stone-400">
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
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <p className="text-sm">A2A 功能开发中</p>
            <p className="mt-1 text-xs">Agent-to-Agent 通信能力即将上线</p>
          </div>
        )}
      </div>

      <McpServerEditorModal
        open={editorOpen}
        editName={editName}
        onClose={() => setEditorOpen(false)}
      />
    </div>
  )
}

export default AgentExtensions
