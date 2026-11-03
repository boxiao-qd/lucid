// ExecutionView — shows the DAG of a sub-agent task run.
// Clicking a node opens a modal dialog with the agent's conversation details.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  type Node,
  type Edge,
  type NodeMouseHandler,
  Position,
  MarkerType
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useUIStore } from '../store/uiStore'
import type {
  TaskRun,
  AgentGraph,
  AgentDefinitionFull,
  RunMemberSession
} from '@shared/subagent-types'
import type { Message } from '@shared/types'
import { groupMessages, MessageGroup } from './MessageBlock'
import MarkdownRenderer from './MarkdownRenderer'
import robotLogo from '../assets/robot-lucid.png'

// Status → label only. Node visual style is uniform (white card, stone border).
// Status is indicated by an icon badge on the node's corner, not by card color.
const STATUS_CONFIG: Record<string, { label: string }> = {
  pending: { label: '等待中' },
  running: { label: '执行中' },
  completed: { label: '已完成' },
  failed: { label: '失败' }
}

// Status icon badge — rendered at the node's top-right corner.
function StatusBadge({ status }: { status: string }): React.JSX.Element | null {
  if (status === 'running') {
    return (
      <div className="absolute -right-3 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-md ring-2 ring-stone-200">
        <svg
          className="h-3.5 w-3.5 animate-spin text-stone-600"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
        </svg>
      </div>
    )
  }
  if (status === 'completed') {
    return (
      <div className="absolute -right-3 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 shadow-md ring-2 ring-white">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className="absolute -right-3 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 shadow-md ring-2 ring-white">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </div>
    )
  }
  return null
}

// Custom node component for React Flow
function AgentNode({
  data
}: {
  data: {
    label: string
    emoji?: string
    description?: string
    status: string
    role: string
    agentId: string
  }
}): React.JSX.Element {
  const isLeader = data.role === 'leader'

  return (
    <div className="relative flex w-[200px] flex-col overflow-visible rounded-xl bg-white shadow-md ring-2 ring-stone-200 transition-all duration-300">
      {/* React Flow handles — edges attach here. Invisible so they don't
          affect the visual design. Source=bottom (outgoing), Target=top
          (incoming). */}
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} className="opacity-0" />

      {/* Header: logo + role badge */}
      <div className="flex items-center gap-2.5 px-3 pt-2.5 pb-1">
        <div className="relative flex-shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-stone-100 text-xl">
            {data.emoji ?? '🤖'}
          </div>
          {isLeader && (
            <div className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-stone-800 text-[8px] font-bold text-white ring-2 ring-white">
              L
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-semibold text-stone-800">{data.label}</span>
          {data.description && (
            <div className="truncate text-[10px] text-stone-400">{data.description}</div>
          )}
        </div>
      </div>

      {/* Footer: status label */}
      <div className="flex items-center justify-between px-3 pb-2 pt-1">
        <span className="text-[10px] text-stone-400">{STATUS_CONFIG[data.status]?.label}</span>
        <span className="font-mono text-[9px] text-stone-300">{data.agentId.slice(0, 12)}</span>
      </div>

      {/* Status badge — spinner / checkmark / cross */}
      <StatusBadge status={data.status} />
    </div>
  )
}

const nodeTypes = { agent: AgentNode }

function ExecutionView(): React.JSX.Element {
  const runId = useUIStore((s) => s.executionRunId)
  const closeExecution = useUIStore((s) => s.closeExecution)

  const [run, setRun] = useState<TaskRun | null>(null)
  const [graph, setGraph] = useState<AgentGraph | null>(null)
  const [agentDefs, setAgentDefs] = useState<Map<string, AgentDefinitionFull>>(new Map())
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [sessionMessages, setSessionMessages] = useState<Message[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const modalScrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)
  const prevSelectedAgentRef = useRef<string | null>(null)

  // Refs for the agent:event listener — updated on every render so the
  // subscription (set up once) always filters by the current selection.
  // Keep the ref as the last non-null agentId even when the modal is closed,
  // so streaming events continue to accumulate while the user is away.
  // When the modal is reopened, the accumulated content is visible.
  const selectedAgentIdRef = useRef<string | null>(null)
  const runIdRef = useRef<string | null>(null)
  if (selectedAgentId) {
    selectedAgentIdRef.current = selectedAgentId
  }
  runIdRef.current = run?.runId ?? null

  // Load task run + graph + agent definitions
  const loadRun = useCallback(async (): Promise<void> => {
    if (!runId) return
    const taskRun = await window.api.subagent.getTaskRun(runId)
    if (!taskRun) return
    setRun(taskRun)

    // Load graph for expert_panel type
    if (taskRun.expertType === 'expert_panel') {
      const g = await window.api.subagent.getGraph(taskRun.expertAgentId)
      setGraph(g)
      if (g) {
        const defs = new Map<string, AgentDefinitionFull>()
        for (const node of g.nodes) {
          if (!defs.has(node.agentId)) {
            const def = await window.api.subagent.getExpert(node.agentId)
            if (def) defs.set(node.agentId, def)
          }
        }
        setAgentDefs(defs)
      }
    } else {
      const def = await window.api.subagent.getExpert(taskRun.expertAgentId)
      if (def) setAgentDefs(new Map([[taskRun.expertAgentId, def]]))
    }
  }, [runId])

  useEffect(() => {
    void loadRun()
  }, [loadRun])

  // Poll for updates while running
  useEffect(() => {
    if (!runId) return
    const poll = async (): Promise<void> => {
      const taskRun = await window.api.subagent.getTaskRun(runId)
      if (taskRun) {
        setRun((prev) => {
          if (prev && JSON.stringify(prev) === JSON.stringify(taskRun)) return prev
          return taskRun
        })
      }
    }
    pollRef.current = setInterval(() => {
      void poll()
    }, 1500)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [runId])

  // Build React Flow nodes and edges
  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if (!run) return { nodes: [], edges: [] }

    // For expert_panel: wait for graph to load before rendering any nodes.
    // If we render the leader node first (without edges) and then add edges
    // later, React Flow may keep the stale leader node and fail to attach
    // edges. Returning empty until graph is ready avoids this race.
    if (run.expertType === 'expert_panel' && !graph) {
      return { nodes: [], edges: [] }
    }

    // For single expert: one node
    if (run.expertType !== 'expert_panel' || !graph) {
      const def = agentDefs.get(run.expertAgentId)
      return {
        nodes: [
          {
            id: run.expertAgentId,
            type: 'agent',
            position: { x: 300, y: 200 },
            data: {
              label: def?.name ?? run.expertName,
              emoji: def?.emoji ?? run.expertEmoji,
              description: def?.description,
              status: run.status,
              role: 'single',
              agentId: run.expertAgentId
            },
            targetPosition: Position.Top,
            sourcePosition: Position.Bottom
          }
        ],
        edges: []
      }
    }

    // For expert_panel: render the DAG
    const leaderNode = graph.nodes.find((n) => n.role === 'leader')
    const memberNodes = graph.nodes.filter((n) => n.role === 'member')

    const memberSessionMap = new Map<string, RunMemberSession>()
    for (const ms of run.memberSessions) {
      memberSessionMap.set(ms.agentId, ms)
    }

    const nfNodes: Node[] = []

    // Leader node at top center
    if (leaderNode) {
      const def = agentDefs.get(leaderNode.agentId)
      nfNodes.push({
        id: leaderNode.agentId,
        type: 'agent',
        position: { x: 400, y: 0 },
        data: {
          label: def?.name ?? run.expertName,
          emoji: def?.emoji ?? run.expertEmoji,
          description: def?.description,
          status: run.status,
          role: 'leader',
          agentId: leaderNode.agentId
        },
        targetPosition: Position.Top,
        sourcePosition: Position.Bottom,
        style: { width: 200 }
      })
    }

    // Member nodes — always in a horizontal row below the leader.
    // The visual layout is the same for serial and concurrent execution;
    // execution mode only affects runtime order, not the DAG topology.
    const memberSpacingX = 260
    const startX = 400 - ((memberNodes.length - 1) * memberSpacingX) / 2

    memberNodes.forEach((node, i) => {
      const def = agentDefs.get(node.agentId)
      const ms = memberSessionMap.get(node.agentId)
      const status = ms?.status ?? 'pending'
      nfNodes.push({
        id: node.agentId,
        type: 'agent',
        position: { x: startX + i * memberSpacingX, y: 220 },
        data: {
          label: def?.name ?? node.agentId,
          emoji: def?.emoji,
          description: def?.description,
          status,
          role: 'member',
          agentId: node.agentId
        },
        targetPosition: Position.Top,
        sourcePosition: Position.Bottom,
        style: { width: 200 }
      })
    })

    // Edges from leader to each member.
    // - Default: light gray (#d6d3d1), bezier curve
    // - Leader → running member: animated, slightly darker
    // - Leader → completed/failed member: light gray
    const nfEdges: Edge[] = graph.edges.map((e) => {
      const ms = memberSessionMap.get(e.to)
      const targetRunning = ms?.status === 'running'
      return {
        id: `${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
        type: 'bezier',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 20,
          height: 20,
          color: '#d6d3d1'
        },
        style: {
          stroke: '#d6d3d1',
          strokeWidth: targetRunning ? 3 : 2
        },
        animated: targetRunning
      }
    })

    return { nodes: nfNodes, edges: nfEdges }
  }, [run, graph, agentDefs])

  // Load session messages for the selected node
  const loadSessionMessages = useCallback(
    async (agentId: string, isPolling = false): Promise<void> => {
      if (!run) return
      let sessionId: string | null = null
      if (agentId === run.expertAgentId) {
        sessionId = run.leaderSessionId
      } else {
        const ms = run.memberSessions.find((m) => m.agentId === agentId)
        if (ms) sessionId = ms.sessionId
      }
      if (!sessionId) {
        // No session for this node — clear previous messages so we don't
        // show another agent's conversation.
        setSessionMessages([])
        return
      }

      // Only show loading spinner on initial load, not during polling.
      // This prevents the spinner from flickering on every 2s refresh.
      if (!isPolling) setLoadingMessages(true)
      try {
        const msgs = await window.api.subagent.getSessionMessages(agentId, sessionId)
        // Only update state if content actually changed — deep comparison
        // via JSON.stringify prevents unnecessary re-renders that cause
        // the modal to flicker every 2 seconds during polling.
        setSessionMessages((prev) => {
          if (prev.length === msgs.length) {
            const prevJson = prev.map((m) => `${m.id}:${m.content}`).join('\n')
            const newJson = msgs.map((m) => `${m.id}:${m.content}`).join('\n')
            if (prevJson === newJson) return prev
          }
          return msgs
        })
      } finally {
        if (!isPolling) setLoadingMessages(false)
      }
    },
    [run]
  )

  const onNodeClick: NodeMouseHandler = useCallback(
    (_e, node) => {
      setSelectedAgentId(node.id)
      void loadSessionMessages(node.id)
    },
    [loadSessionMessages]
  )

  // Auto-refresh session messages if the selected node is still running
  useEffect(() => {
    if (!selectedAgentId || !run) return
    const ms = run.memberSessions.find((m) => m.agentId === selectedAgentId)
    const isLeader = selectedAgentId === run.expertAgentId
    const isRunning = isLeader ? run.status === 'running' : ms?.status === 'running'
    if (!isRunning) return

    const interval = setInterval(() => {
      void loadSessionMessages(selectedAgentId, true)
    }, 2000)
    return () => clearInterval(interval)
  }, [selectedAgentId, run, loadSessionMessages])

  // Subscribe to agent:event for real-time streaming from the selected
  // sub-agent. Events are tagged with agentId + runId by tagEmit in
  // subagent-runner.ts. The agentStore blocks them via its agentId guard,
  // so they don't affect the main chat — but we can listen here to show
  // streaming text/thinking in real-time, instead of waiting for the 2s
  // JSONL poll.
  useEffect(() => {
    const off = window.api.agent.onEvent((env) => {
      const data = env.data as {
        agentId?: string
        runId?: string
        delta?: string
      }
      // Only process events for the currently selected agent node
      if (!selectedAgentIdRef.current) return
      if (data.agentId !== selectedAgentIdRef.current) return
      if (runIdRef.current && data.runId && data.runId !== runIdRef.current) return

      switch (env.type) {
        case 'stream_start':
          setStreamingText('')
          setStreamingThinking('')
          break
        case 'thinking_start':
          setStreamingThinking('')
          break
        case 'thinking_delta':
          setStreamingThinking((prev) => prev + (data.delta ?? ''))
          break
        case 'thinking_end':
          // Thinking is persisted to JSONL after this event — clear
          // streaming thinking; polling will pick up the persisted version.
          setStreamingThinking('')
          break
        case 'text_delta':
          setStreamingText((prev) => prev + (data.delta ?? ''))
          break
        case 'tool_call_end':
          // Text before tool calls is persisted to JSONL — clear streaming
          // text; polling will pick up the persisted version + tool call.
          setStreamingText('')
          break
        case 'message_done':
          // Final text is persisted to JSONL — clear all streaming state.
          setStreamingText('')
          setStreamingThinking('')
          break
      }
    })
    return off
  }, [])

  // Clear streaming state only when switching to a DIFFERENT agent node.
  // When closing/reopening the modal for the same agent, preserve streaming
  // state so content that accumulated while the modal was closed is not lost.
  // Also reset scroll-to-bottom behavior whenever the modal opens.
  useEffect(() => {
    if (selectedAgentId) {
      userScrolledUpRef.current = false
      if (prevSelectedAgentRef.current !== selectedAgentId) {
        setStreamingText('')
        setStreamingThinking('')
      }
    }
  }, [selectedAgentId])

  // Close modal on Escape
  useEffect(() => {
    if (!selectedAgentId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelectedAgentId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectedAgentId])

  // Auto-scroll modal to bottom when messages update, unless user scrolled up
  useEffect(() => {
    if (!modalScrollRef.current) return
    if (sessionMessages.length === 0 && !streamingText && !streamingThinking) return

    // Switching to a different agent node — force scroll to bottom
    if (prevSelectedAgentRef.current !== selectedAgentId) {
      prevSelectedAgentRef.current = selectedAgentId
      userScrolledUpRef.current = false
      modalScrollRef.current.scrollTop = modalScrollRef.current.scrollHeight
      return
    }

    if (!userScrolledUpRef.current) {
      modalScrollRef.current.scrollTop = modalScrollRef.current.scrollHeight
    }
  }, [sessionMessages, selectedAgentId, streamingText, streamingThinking])

  // --- Early returns ---
  if (!runId) {
    return (
      <div className="flex h-full flex-1 items-center justify-center text-stone-400">
        未指定执行记录
      </div>
    )
  }

  if (!run) {
    return (
      <div className="flex h-full flex-1 items-center justify-center text-stone-400">加载中...</div>
    )
  }

  const runStatusCfg = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.pending

  // --- Modal dialog (session messages) ---
  const selectedDef = selectedAgentId ? agentDefs.get(selectedAgentId) : null
  const selectedMs =
    selectedAgentId && run ? run.memberSessions.find((m) => m.agentId === selectedAgentId) : null
  const selectedIsLeader = selectedAgentId === run.expertAgentId
  const selectedStatus = selectedIsLeader ? run.status : (selectedMs?.status ?? 'pending')
  const selectedIsRunning = selectedStatus === 'running'
  const selectedStatusCfg = STATUS_CONFIG[selectedStatus] ?? STATUS_CONFIG.pending

  // Create a synthetic thinking message from the streaming thinking content.
  // groupMessages merges all thinking within a turn into one group, so the
  // streaming thinking appears in the same card as persisted thinking —
  // consistent with Lucid's main chat ThinkingCard. No separate box.
  const streamingThinkingMsg: Message | null = streamingThinking
    ? {
        id: 'streaming-thinking-live',
        type: 'thinking',
        role: 'assistant',
        content: streamingThinking,
        createdAt: Date.now()
      }
    : null
  const messagesForRender = streamingThinkingMsg
    ? [...sessionMessages, streamingThinkingMsg]
    : sessionMessages

  const modalDialog = selectedAgentId ? (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => setSelectedAgentId(null)}
    >
      <div
        className="flex max-h-[85vh] w-[90%] max-w-[1200px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <div className="flex items-center gap-3">
            <img src={robotLogo} alt="" className="h-8 w-8 rounded-lg" />
            <div>
              <div className="flex items-center gap-2">
                {selectedDef?.emoji && <span className="text-sm">{selectedDef.emoji}</span>}
                <span className="text-sm font-semibold text-stone-800">
                  {selectedDef?.name ?? selectedAgentId}
                </span>
                {selectedIsLeader && (
                  <span className="rounded bg-stone-800 px-1.5 py-0.5 text-[9px] font-medium text-white">
                    LEADER
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-stone-400">{selectedStatusCfg.label}</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => setSelectedAgentId(null)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
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

        {/* Modal body — session messages */}
        <div
          ref={modalScrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
            userScrolledUpRef.current = !isNearBottom
          }}
          className="flex-1 overflow-y-auto bg-stone-50 px-5 py-4"
        >
          {loadingMessages ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-stone-400">
              <svg
                className="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
              </svg>
              加载会话内容...
            </div>
          ) : sessionMessages.length === 0 && !streamingText && !streamingThinking ? (
            <div className="py-12 text-center text-xs text-stone-400">暂无会话内容</div>
          ) : (
            <div className="space-y-3">
              {groupMessages(messagesForRender).map((group) => (
                <MessageGroup key={group[0].id} messages={group} isRunning={selectedIsRunning} />
              ))}

              {/* Real-time streaming text — shown between polling updates.
                  Cleared when the content is persisted to JSONL
                  (tool_call_end / message_done), at which point polling
                  picks up the persisted version. Thinking is NOT shown
                  here — it's merged into the thinking group above via
                  the synthetic message in messagesForRender. */}
              {streamingText && (
                <div className="w-full">
                  <MarkdownRenderer content={streamingText} />
                  <span className="mt-1 block h-1 w-2 animate-pulse rounded-full bg-stone-400" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  ) : null

  return (
    <div className="flex h-full flex-1 flex-col bg-stone-50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-stone-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={closeExecution}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100"
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
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            返回
          </button>
          <div className="h-4 w-px bg-stone-200" />
          <div className="flex items-center gap-2.5">
            <img src={robotLogo} alt="" className="h-6 w-6 rounded-lg" />
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-stone-800">{run.expertName}</span>
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-500">
                {run.expertType === 'expert_panel' ? '专家团' : '单专家'}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-500">
          {runStatusCfg.label}
        </div>
      </div>

      {/* Task description */}
      <div className="border-b border-stone-200 bg-white px-4 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">
            任务
          </span>
          <span className="flex-1 text-sm text-stone-600">{run.task}</span>
        </div>
      </div>

      {/* Main content: DAG + modal overlay */}
      <div className="relative flex flex-1 overflow-hidden">
        <div className="flex-1 bg-stone-50">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={{
              type: 'bezier',
              style: { stroke: '#d6d3d1', strokeWidth: 2 },
              markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: '#d6d3d1' }
            }}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#d6d3d1" gap={24} size={1.5} />
            <Controls showInteractive={false} className="!border-stone-200 !bg-white !shadow-md" />
          </ReactFlow>
        </div>
        {modalDialog}
      </div>
    </div>
  )
}

export default ExecutionView
