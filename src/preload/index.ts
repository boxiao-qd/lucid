import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
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

// --- Confirm overlay window data caching ---
// The main process sends 'confirm:data' after the overlay window finishes
// loading. The React component registers its listener via onData(). If the
// data arrives before the component mounts (race condition), the cached
// value is immediately delivered when onData() is called.
interface ConfirmData {
  confirmationId: string
  sessionId: string
  toolName: string
  content: string
  choices?: ToolConfirmChoice[]
  commandBlocks?: ToolConfirmCommandBlock[]
  purpose?: string
}

let _confirmData: ConfirmData | null = null
const _confirmCallbacks: Array<(data: ConfirmData) => void> = []

ipcRenderer.on('confirm:data', (_: unknown, data: ConfirmData) => {
  _confirmData = data
  for (const cb of _confirmCallbacks) cb(data)
})

// Custom APIs for renderer
const api = {
  platform: process.platform,
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized')
  },
  settings: {
    read: (): Promise<SettingsConfig> => ipcRenderer.invoke('settings:read'),
    write: (config: SettingsConfig): Promise<void> => ipcRenderer.invoke('settings:write', config),
    setActiveModel: (category: 'main' | 'multimodal', id: string): Promise<SettingsConfig> =>
      ipcRenderer.invoke('settings:setActiveModel', category, id),
    setSecurityMode: (mode: 'safe' | 'unrestricted'): Promise<void> =>
      ipcRenderer.invoke('settings:setSecurityMode', mode)
  },
  sessions: {
    list: (): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list'),
    create: (): Promise<SessionMeta> => ipcRenderer.invoke('sessions:create'),
    get: (id: string): Promise<Message[]> => ipcRenderer.invoke('sessions:get', id),
    appendMessage: (
      id: string,
      role: 'user' | 'assistant',
      content: string,
      attachments?: string[]
    ): Promise<Message> =>
      ipcRenderer.invoke('sessions:appendMessage', id, role, content, attachments),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', id)
  },
  agent: {
    run: (
      sessionId: string,
      content: string,
      attachments?: string[],
      skillSlug?: string,
      expertAgentId?: string
    ): Promise<void> =>
      ipcRenderer.invoke('agent:run', sessionId, content, attachments, skillSlug, expertAgentId),
    queue: (sessionId: string, content: string, attachments?: string[]): Promise<void> =>
      ipcRenderer.invoke('agent:queue', sessionId, content, attachments),
    steer: (sessionId: string, content: string): Promise<{ mode: string }> =>
      ipcRenderer.invoke('agent:steer', sessionId, content),
    cancel: (sessionId: string): Promise<void> => ipcRenderer.invoke('agent:cancel', sessionId),
    isActive: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('agent:isActive', sessionId),
    confirmTool: (
      sessionId: string,
      confirmationId: string,
      action: 'approve_once' | 'approve_session' | 'reject',
      text?: string,
      choiceIndex?: number
    ): Promise<boolean> =>
      ipcRenderer.invoke('agent:confirmTool', sessionId, confirmationId, action, text, choiceIndex),
    onEvent: (cb: (env: AgentEventEnvelope) => void): (() => void) => {
      const handler = (_: unknown, env: AgentEventEnvelope): void => cb(env)
      ipcRenderer.on('agent:event', handler)
      return () => ipcRenderer.removeListener('agent:event', handler)
    }
  },
  uploads: {
    save: (sessionId: string, dataUrl: string, fileName?: string): Promise<string> =>
      ipcRenderer.invoke('uploads:save', sessionId, dataUrl, fileName),
    readAsDataUrl: (filePath: string): Promise<string> =>
      ipcRenderer.invoke('uploads:readAsDataUrl', filePath)
  },
  files: {
    list: (): Promise<SessionFiles[]> => ipcRenderer.invoke('files:list'),
    readText: (filePath: string): Promise<string> => ipcRenderer.invoke('files:readText', filePath),
    listDir: (sessionId: string, relativePath: string): Promise<WorkspaceFile[]> =>
      ipcRenderer.invoke('files:listDir', sessionId, relativePath),
    delete: (filePath: string): Promise<void> => ipcRenderer.invoke('files:delete', filePath)
  },
  shell: {
    showItemInFolder: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('shell:showItemInFolder', filePath)
  },
  skills: {
    list: (): Promise<Skill[]> => ipcRenderer.invoke('skills:list'),
    create: (data: {
      name: string
      description: string
      emoji?: string
      content: string
    }): Promise<Skill> => ipcRenderer.invoke('skills:create', data),
    update: (
      slug: string,
      data: Partial<{ name: string; description: string; emoji?: string; content: string }>
    ): Promise<Skill> => ipcRenderer.invoke('skills:update', slug, data),
    delete: (slug: string): Promise<void> => ipcRenderer.invoke('skills:delete', slug),
    hubSearch: (query: string): Promise<HubSkill[]> =>
      ipcRenderer.invoke('skills:hubSearch', query),
    hubInstall: (slug: string): Promise<Skill> => ipcRenderer.invoke('skills:hubInstall', slug)
  },
  experts: {
    list: (): Promise<Expert[]> => ipcRenderer.invoke('experts:list'),
    create: (data: {
      name: string
      description: string
      emoji?: string
      content: string
    }): Promise<Expert> => ipcRenderer.invoke('experts:create', data),
    update: (
      slug: string,
      data: Partial<{ name: string; description: string; emoji?: string; content: string }>
    ): Promise<Expert> => ipcRenderer.invoke('experts:update', slug, data),
    delete: (slug: string): Promise<void> => ipcRenderer.invoke('experts:delete', slug)
  },
  mcp: {
    getConfig: (): Promise<McpConfig> => ipcRenderer.invoke('mcp:getConfig'),
    addServer: (name: string, config: McpServerConfig): Promise<McpConfig> =>
      ipcRenderer.invoke('mcp:addServer', name, config),
    updateServer: (name: string, config: Partial<McpServerConfig>): Promise<McpConfig> =>
      ipcRenderer.invoke('mcp:updateServer', name, config),
    deleteServer: (name: string): Promise<McpConfig> =>
      ipcRenderer.invoke('mcp:deleteServer', name),
    testServer: (config: McpServerConfig): Promise<{ tools: McpToolInfo[]; error?: string }> =>
      ipcRenderer.invoke('mcp:testServer', config)
  },
  scheduler: {
    list: (): Promise<CronJob[]> => ipcRenderer.invoke('scheduler:list'),
    add: (job: CronJobCreate): Promise<CronJob> => ipcRenderer.invoke('scheduler:add', job),
    update: (id: string, patch: CronJobPatch): Promise<CronJob | null> =>
      ipcRenderer.invoke('scheduler:update', id, patch),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('scheduler:remove', id),
    run: (id: string): Promise<CronRunOutcome | null> => ipcRenderer.invoke('scheduler:run', id),
    status: (): Promise<CronStatusSummary> => ipcRenderer.invoke('scheduler:status'),
    listRuns: (): Promise<CronRunRecord[]> => ipcRenderer.invoke('scheduler:listRuns'),
    clearRuns: (): Promise<boolean> => ipcRenderer.invoke('scheduler:clearRuns')
  },
  trace: {
    get: (sessionId: string): Promise<TurnTrace[]> => ipcRenderer.invoke('trace:get', sessionId),
    getAll: (): Promise<TurnTrace[]> => ipcRenderer.invoke('trace:getAll'),
    clear: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('trace:clear', sessionId)
  },
  memory: {
    list: (): Promise<Memory[]> => ipcRenderer.invoke('memory:list'),
    create: (content: string, tier?: MemoryTier): Promise<Memory | null> =>
      ipcRenderer.invoke('memory:create', content, tier),
    update: (id: string, content: string, tier?: MemoryTier): Promise<Memory | null> =>
      ipcRenderer.invoke('memory:update', id, content, tier),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id)
  },
  subagent: {
    listExperts: (): Promise<AgentDefinitionFull[]> => ipcRenderer.invoke('subagent:listExperts'),
    getExpert: (agentId: string): Promise<AgentDefinitionFull | null> =>
      ipcRenderer.invoke('subagent:getExpert', agentId),
    getGraph: (agentId: string): Promise<AgentGraph | null> =>
      ipcRenderer.invoke('subagent:getGraph', agentId),
    getTaskRuns: (sessionId: string): Promise<TaskRunIndexEntry[]> =>
      ipcRenderer.invoke('subagent:getTaskRuns', sessionId),
    getTaskRun: (runId: string): Promise<TaskRun | null> =>
      ipcRenderer.invoke('subagent:getTaskRun', runId),
    getSessionMessages: (agentId: string, sessionId: string): Promise<Message[]> =>
      ipcRenderer.invoke('subagent:getSessionMessages', agentId, sessionId)
  },
  confirm: {
    onData: (cb: (data: ConfirmData) => void): (() => void) => {
      // If data already cached (arrived before this listener registered),
      // deliver it immediately.
      if (_confirmData) cb(_confirmData)
      _confirmCallbacks.push(cb)
      return () => {
        const idx = _confirmCallbacks.indexOf(cb)
        if (idx >= 0) _confirmCallbacks.splice(idx, 1)
      }
    },
    respond: (
      sessionId: string,
      confirmationId: string,
      action: 'approve_once' | 'approve_session' | 'reject',
      text?: string,
      choiceIndex?: number
    ): Promise<boolean> =>
      ipcRenderer.invoke('agent:confirmTool', sessionId, confirmationId, action, text, choiceIndex),
    close: (): void => {
      window.close()
    },
    resize: (height: number): void => {
      ipcRenderer.send('confirm:resize', height)
    }
  },
  browser: {
    attachGuest: (sessionId: string, webContentsId: number): Promise<void> =>
      ipcRenderer.invoke('browser:attachGuest', sessionId, webContentsId),
    detachGuest: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke('browser:detachGuest', sessionId),
    close: (sessionId: string): Promise<void> => ipcRenderer.invoke('browser:close', sessionId)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
