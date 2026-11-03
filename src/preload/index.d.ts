import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  SettingsConfig,
  SessionMeta,
  Message,
  SessionFiles,
  WorkspaceFile,
  Skill,
  HubSkill,
  Expert,
  McpConfig,
  McpServerConfig,
  McpToolInfo,
  Memory,
  MemoryTier
} from '../shared/types'
import type {
  AgentEventEnvelope,
  ToolConfirmChoice,
  ToolConfirmCommandBlock
} from '../shared/agent-events'
import type {
  AgentDefinitionFull,
  AgentGraph,
  TaskRun,
  TaskRunIndexEntry
} from '../shared/subagent-types'
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunOutcome,
  CronRunRecord,
  CronStatusSummary
} from '../main/scheduler/types'
import type { TurnTrace } from '../shared/trace'

interface ConfirmData {
  confirmationId: string
  sessionId: string
  toolName: string
  content: string
  choices?: ToolConfirmChoice[]
  commandBlocks?: ToolConfirmCommandBlock[]
}

interface WindowControlAPI {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<boolean>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
}

interface SettingsAPI {
  read: () => Promise<SettingsConfig>
  write: (config: SettingsConfig) => Promise<void>
  setActiveModel: (category: 'main' | 'multimodal', id: string) => Promise<SettingsConfig>
  setSecurityMode: (mode: 'safe' | 'unrestricted') => Promise<void>
}

interface SessionsAPI {
  list: () => Promise<SessionMeta[]>
  create: () => Promise<SessionMeta>
  get: (id: string) => Promise<Message[]>
  appendMessage: (
    id: string,
    role: 'user' | 'assistant',
    content: string,
    attachments?: string[]
  ) => Promise<Message>
  delete: (id: string) => Promise<void>
}

interface AgentAPI {
  run: (
    sessionId: string,
    content: string,
    attachments?: string[],
    skillSlug?: string,
    expertAgentId?: string
  ) => Promise<void>
  queue: (sessionId: string, content: string, attachments?: string[]) => Promise<void>
  steer: (sessionId: string, content: string) => Promise<{ mode: string }>
  cancel: (sessionId: string) => Promise<void>
  isActive: (sessionId: string) => Promise<boolean>
  confirmTool: (
    sessionId: string,
    confirmationId: string,
    action: 'approve_once' | 'approve_session' | 'reject',
    text?: string,
    choiceIndex?: number
  ) => Promise<boolean>
  onEvent: (cb: (env: AgentEventEnvelope) => void) => () => void
}

interface UploadsAPI {
  save: (sessionId: string, dataUrl: string, fileName?: string) => Promise<string>
  readAsDataUrl: (filePath: string) => Promise<string>
}

interface FilesAPI {
  list: () => Promise<SessionFiles[]>
  readText: (filePath: string) => Promise<string>
  listDir: (sessionId: string, relativePath: string) => Promise<WorkspaceFile[]>
  delete: (filePath: string) => Promise<void>
}

interface ShellAPI {
  showItemInFolder: (filePath: string) => Promise<void>
}

interface SkillsAPI {
  list: () => Promise<Skill[]>
  create: (data: {
    name: string
    description: string
    emoji?: string
    content: string
  }) => Promise<Skill>
  update: (
    slug: string,
    data: Partial<{ name: string; description: string; emoji?: string; content: string }>
  ) => Promise<Skill>
  delete: (slug: string) => Promise<void>
  hubSearch: (query: string) => Promise<HubSkill[]>
  hubInstall: (slug: string) => Promise<Skill>
}

interface ExpertsAPI {
  list: () => Promise<Expert[]>
  create: (data: {
    name: string
    description: string
    emoji?: string
    content: string
  }) => Promise<Expert>
  update: (
    slug: string,
    data: Partial<{ name: string; description: string; emoji?: string; content: string }>
  ) => Promise<Expert>
  delete: (slug: string) => Promise<void>
}

interface McpAPI {
  getConfig: () => Promise<McpConfig>
  addServer: (name: string, config: McpServerConfig) => Promise<McpConfig>
  updateServer: (name: string, config: Partial<McpServerConfig>) => Promise<McpConfig>
  deleteServer: (name: string) => Promise<McpConfig>
  testServer: (config: McpServerConfig) => Promise<{ tools: McpToolInfo[]; error?: string }>
}

interface SchedulerAPI {
  list: () => Promise<CronJob[]>
  add: (job: CronJobCreate) => Promise<CronJob>
  update: (id: string, patch: CronJobPatch) => Promise<CronJob | null>
  remove: (id: string) => Promise<boolean>
  run: (id: string) => Promise<CronRunOutcome | null>
  status: () => Promise<CronStatusSummary>
  listRuns: () => Promise<CronRunRecord[]>
  clearRuns: () => Promise<boolean>
}

interface TraceAPI {
  get: (sessionId: string) => Promise<TurnTrace[]>
  getAll: () => Promise<TurnTrace[]>
  clear: (sessionId: string) => Promise<boolean>
}

interface MemoryAPI {
  list: () => Promise<Memory[]>
  create: (content: string, tier?: MemoryTier) => Promise<Memory | null>
  update: (id: string, content: string, tier?: MemoryTier) => Promise<Memory | null>
  delete: (id: string) => Promise<void>
}

interface SubagentAPI {
  listExperts: () => Promise<AgentDefinitionFull[]>
  getExpert: (agentId: string) => Promise<AgentDefinitionFull | null>
  getGraph: (agentId: string) => Promise<AgentGraph | null>
  getTaskRuns: (sessionId: string) => Promise<TaskRunIndexEntry[]>
  getTaskRun: (runId: string) => Promise<TaskRun | null>
  getSessionMessages: (agentId: string, sessionId: string) => Promise<Message[]>
}

interface ConfirmAPI {
  onData: (cb: (data: ConfirmData) => void) => () => void
  respond: (
    sessionId: string,
    confirmationId: string,
    action: 'approve_once' | 'approve_session' | 'reject',
    text?: string,
    choiceIndex?: number
  ) => Promise<boolean>
  close: () => void
  resize: (height: number) => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      platform: NodeJS.Platform
      window: WindowControlAPI
      settings: SettingsAPI
      sessions: SessionsAPI
      agent: AgentAPI
      uploads: UploadsAPI
      files: FilesAPI
      shell: ShellAPI
      skills: SkillsAPI
      experts: ExpertsAPI
      mcp: McpAPI
      scheduler: SchedulerAPI
      trace: TraceAPI
      memory: MemoryAPI
      subagent: SubagentAPI
      confirm: ConfirmAPI
    }
  }
}
