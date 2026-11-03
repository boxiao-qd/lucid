// Sub-agent (专家模块) shared types.
// See docs/专家模块数据结构设计.md for the full design.

// ===== Main-session Message extension =====

/**
 * Expert reference attached to `session_spawn` tool_call messages in the main
 * lucid session. Provides direct access to the sub-agent run + leader session.
 * Absent on normal messages and other tool calls.
 */
export interface MessageExpertRef {
  /** Task run ID, maps to ~/.lucid/subagent/runs/{runId}.json */
  runId: string
  /** The agentId of the expert the user selected. */
  expertAgentId: string
  /**
   * Sub-agent session ID for this invocation.
   * `single` → the expert's own session;
   * `expert_panel` → the team leader's session.
   * The UI can read the JSONL directly from this ID.
   */
  leaderSessionId: string
}

// ===== Sub-agent definitions =====

/** Expert type. `single` = one agent; `expert_panel` = team leader + DAG of members. */
export type AgentType = 'single' | 'expert_panel'

/** Three-layer tool filtering config (AGENT.md frontmatter). */
export interface AgentToolsConfig {
  /** Whitelist. "*" means all tools. */
  allow?: string[]
  /** Blacklist. Always wins over allow. */
  deny?: string[]
}

/** AGENT.md frontmatter. */
export interface AgentDefinition {
  agentId: string
  name: string
  description: string
  emoji?: string
  type: AgentType
  maxTurns?: number
  tools?: AgentToolsConfig
  exposed?: boolean
  color?: string
  background?: boolean
  createdAt?: number
  updatedAt?: number
}

/** Full agent definition: frontmatter + markdown body (system prompt). */
export interface AgentDefinitionFull extends AgentDefinition {
  /** Markdown body — injected as the system prompt. */
  systemPrompt: string
}

// ===== Call graph (graph.yaml) =====

export type GraphNodeRole = 'leader' | 'member'

export interface GraphNode {
  agentId: string
  role: GraphNodeRole
}

export interface GraphEdge {
  from: string
  to: string
}

export type ExecutionMode = 'concurrent' | 'serial'

export interface AgentGraph {
  agentId: string
  graphType: 'DAG'
  nodes: GraphNode[]
  edges: GraphEdge[]
  execution: {
    mode: ExecutionMode
  }
}

// ===== Sub-agent sessions =====

export type SessionStatus = 'running' | 'completed' | 'failed'

/** First-line header of a sub-agent session JSONL. */
export interface SubagentSessionHeader {
  type: 'session'
  id: string
  agentId: string
  createdAt: number
  parentRunId: string
  parentSessionId: string
  task: string
}

/** Sub-agent session index entry (sessions.json). */
export interface SubagentSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  parentRunId: string
  parentSessionId: string
  status: SessionStatus
}

/** Sub-agent session index file. */
export interface SubagentSessionsIndex {
  version: number
  agentId: string
  sessions: SubagentSessionMeta[]
}

// ===== Task runs =====

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed'

/** Member session record inside run.json. */
export interface RunMemberSession {
  agentId: string
  sessionId: string
  status: SessionStatus
  startedAt: number
  completedAt: number | null
  result: string | null
}

/** Single task run record (run.json). */
export interface TaskRun {
  version: number
  runId: string
  parentSessionId: string
  parentMessageId: string
  expertAgentId: string
  expertName: string
  expertEmoji?: string
  expertType: AgentType
  leaderSessionId: string
  memberSessions: RunMemberSession[]
  status: RunStatus
  task: string
  createdAt: number
  startedAt: number
  completedAt: number | null
  result: string | null
}

/** Run index entry (index.json) — summary for fast list rendering. */
export interface TaskRunIndexEntry {
  runId: string
  parentSessionId: string
  parentMessageId: string
  expertAgentId: string
  expertName: string
  expertEmoji?: string
  expertType: AgentType
  leaderSessionId: string
  status: RunStatus
  task: string
  createdAt: number
  completedAt: number | null
}

/** Run index file. */
export interface TaskRunIndex {
  version: number
  runs: TaskRunIndexEntry[]
}

// ===== Global config =====

export interface SubagentConfig {
  version: number
  globalTools: {
    deny: string[]
  }
  defaults: {
    maxTurns: number
  }
}

// ===== Sub-agent emit event payload =====

/**
 * Extra data attached to AgentEventEnvelope.data when events come from a
 * sub-agent execution. Frontend routes events by agentId to the right node.
 */
export interface SubagentEventMeta {
  agentId: string
  runId: string
  /** Role of the agent emitting this event. */
  role?: 'leader' | 'member' | 'single'
}
