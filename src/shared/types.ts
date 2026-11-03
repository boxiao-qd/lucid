export interface ModelConfig {
  id: string
  endpoint: string
  name: string
  apiKey: string
  active: boolean
  contextWindow?: number // context window size in tokens; 0 or unset = compaction disabled
}

export type ModelCategory = 'main' | 'auxiliary' | 'multimodal' | 'imageGen'

export type SecurityMode = 'safe' | 'unrestricted'

export interface SettingsConfig {
  main: ModelConfig[]
  auxiliary: ModelConfig[]
  multimodal: ModelConfig[]
  imageGen: ModelConfig[]
  securityMode?: SecurityMode
}

// Default model configurations — pre-populated for a working out-of-the-box
// experience. Users can edit or replace these in Settings.
export function getDefaultSettings(): SettingsConfig {
  return {
    main: [],
    auxiliary: [],
    multimodal: [],
    imageGen: [],
    securityMode: 'safe'
  }
}

// Ensures at most one active model per category. Keeps the first active one,
// deactivates the rest. If none is active, leaves the array as-is.
export function normalizeSettings(config: SettingsConfig): SettingsConfig {
  const normalize = (models: ModelConfig[]): ModelConfig[] => {
    const activeIdx = models.findIndex((m) => m.active)
    if (activeIdx === -1) return models
    return models.map((m, i) => ({ ...m, active: i === activeIdx }))
  }
  return {
    main: normalize(config.main),
    auxiliary: normalize(config.auxiliary),
    multimodal: normalize(config.multimodal),
    imageGen: normalize(config.imageGen),
    securityMode: config.securityMode === 'unrestricted' ? 'unrestricted' : 'safe'
  }
}

// --- Session & conversation ---

export type MessageType = 'text' | 'thinking' | 'plan' | 'tool_call' | 'tool_result'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  type: MessageType
  attachments?: string[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  /**
   * Only present on `session_spawn` tool_call messages. Provides direct access
   * to the sub-agent run + leader session for the "view execution details" UI.
   * @see src/shared/subagent-types.ts MessageExpertRef
   */
  expert?: import('./subagent-types').MessageExpertRef
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

// --- Workspace files ---

export type FileKind = 'image' | 'text' | 'other'

export interface WorkspaceFile {
  name: string
  path: string // absolute path on disk
  size: number // bytes
  mtime: number // last modified time in ms
  kind: FileKind
  isDirectory?: boolean
  /** Human-readable label (e.g. task text for runId folders). Falls back to name. */
  displayName?: string
}

export interface SessionFiles {
  sessionId: string
  sessionTitle: string
  uploads: WorkspaceFile[]
  products: WorkspaceFile[]
  productDir?: string
}

// --- Skills ---

export interface Skill {
  slug: string // directory name, used as ID
  name: string // from frontmatter
  description: string // from frontmatter
  emoji?: string // from frontmatter
  content: string // markdown body (prompt content injected into system prompt)
  source: 'user' | 'hub' // user-created or installed from SkillHub
  createdAt: number
  updatedAt: number
}

export interface Expert {
  slug: string
  name: string
  description: string
  emoji?: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface HubSkill {
  slug: string
  name: string
  description: string
  emoji?: string
  content?: string // only available after fetching the skill card from ClawHub
}

// --- MCP (Model Context Protocol) ---

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>
}

export interface McpToolInfo {
  name: string // tool name (without server prefix)
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpServerInfo {
  name: string // server key
  config: McpServerConfig
  status: 'connected' | 'disconnected' | 'error'
  error?: string
  tools: McpToolInfo[]
}

// --- Memory ---

export type MemoryTier = 'short' | 'long'

export type ExtractionTrigger = 'session_end' | 'llm_judgment' | 'compaction' | 'manual'

export interface Memory {
  id: string
  tier: MemoryTier
  content: string
  sourceSessionId: string
  extractionTrigger: ExtractionTrigger
  hash: string
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown>
}

export interface MemorySearchResult {
  memory: Memory
  score: number
}
