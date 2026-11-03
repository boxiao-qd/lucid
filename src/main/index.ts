import dotenv from 'dotenv'
import { join } from 'path'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// Load .env from the app root — works in both dev (project root) and
// production (asar bundle root, two levels up from out/main/index.js).
dotenv.config({ path: join(__dirname, '../../.env') })
import { readSettings, writeSettings } from './settings'
import {
  listSessions,
  createSession,
  getSessionMessages,
  appendSessionMessage,
  deleteSession
} from './sessions'
import { runAgent } from './agent/agent-runner'
import { createEmitter } from './agent/event-bus'
import { startRun, endRun, cancelRun, trySteer, isActive } from './agent/active-runs'
import { resolveConfirmation, clearSessionApprovals } from './agent/tool-confirmation'
import { warmupClient } from './agent/llm-client'
import {
  enqueueTask,
  dequeueTask,
  hasQueuedTasks,
  getQueueDepth,
  removeFromQueue
} from './agent/task-queue'
import {
  saveUpload,
  readUploadAsDataUrl,
  listWorkspaceFiles,
  readFileText,
  listProductSubDir,
  deleteFile
} from './uploads'
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  hubSearch,
  hubInstall,
  ensureBundledSkills
} from './skills'
import { listExperts, createExpert, updateExpert, deleteExpert } from './experts'
import {
  listExposedAgents,
  loadAgentDefinition,
  seedBundledAgents
} from './subagent/agent-definition'
import { loadAgentGraph } from './subagent/graph-definition'
import { ensureSubagentConfig } from './subagent/subagent-config'
import { listTaskRunsByParentSession, getTaskRun } from './subagent/task-runs'
import { getSubagentSessionMessages } from './subagent/subagent-sessions'
import {
  readMcpConfig,
  addServer as mcpAddServer,
  updateServer as mcpUpdateServer,
  deleteServer as mcpDeleteServer
} from './mcp/mcp-config'
import {
  testMcpServer,
  initMcpRuntime,
  disposeMcpRuntime,
  reloadMcpRuntime
} from './mcp/mcp-runtime'
import { initMemoryDb } from './memory/memory-db'
import {
  getAllMemories,
  insertMemory,
  updateMemoryContent,
  deleteMemory,
  insertVector
} from './memory/memory-db'
import { getEmbedding } from './memory/embedding-provider'
import { writeGuardFiles } from './agent/guard/guard-scripts'
import { getTraces, getAllTraces, clearTraces } from './agent/trace-store'
import {
  initScheduler,
  stopScheduler,
  listJobs,
  addJob,
  updateJob,
  removeJob,
  runJobNow,
  getStatus,
  listRunRecords,
  clearRunRecords
} from './scheduler/scheduler-service'
import type { CronJobCreate, CronJobPatch } from './scheduler/types'
import type { McpServerConfig, MemoryTier } from '../shared/types'
import type { SettingsConfig } from '../shared/types'
import type { WebContents } from 'electron'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Drain queued tasks for a session after the active run finishes.
// Each queued task: append user message → emit user_message_added → run agent.
async function drainQueuedTasks(sessionId: string, sender: WebContents): Promise<void> {
  while (hasQueuedTasks(sessionId)) {
    const entry = dequeueTask(sessionId)
    if (!entry) break

    // Append user message to disk + notify renderer
    const msg = appendSessionMessage(
      sessionId,
      'user',
      entry.content,
      'text',
      undefined,
      entry.attachments
    )
    const emit = createEmitter(sessionId, sender)
    emit('user_message_added', {
      id: msg.id,
      role: 'user',
      content: msg.content,
      createdAt: msg.createdAt
    })

    // Run agent for this queued task — always uses the main model for the
    // agent loop; the vision tool internally calls the multimodal model.
    const settings = readSettings()
    const model = settings.main.find((m) => m.active)
    if (!model) {
      emit('error', {
        error_code: 'NO_MODEL',
        message: '未配置主模型，请先在设置中配置',
        recoverable: false
      })
      break
    }

    const handle = startRun(sessionId)
    try {
      await runAgent({
        sessionId,
        userMessage: entry.content,
        attachments: entry.attachments,
        model,
        history: getSessionMessages(sessionId),
        emit,
        abortSignal: handle.abortController.signal,
        steerQueue: handle.steerQueue
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      emit('error', { error_code: 'RUNNER_ERROR', message: errMsg, recoverable: false })
    } finally {
      endRun(sessionId)
    }
  }
}

// Set dock icon on macOS as early as possible — before app.whenReady() —
// so dev builds don't flash the default Electron icon in the Dock while
// waiting for the ready event. (Electron binary's own Info.plist still
// shows briefly during process startup, but this minimizes the window.)
if (process.platform === 'darwin' && !app.isPackaged) {
  app.dock?.setIcon(icon)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Initialize memory database (SQLite + sqlite-vec + FTS5)
  initMemoryDb()

  // Write workspace guard scripts to ~/.lucid/workspace/.guard/
  // These are sourced/injected by terminal and code_execute tools to
  // prevent file writes outside the workspace directory.
  writeGuardFiles()

  // Initialize scheduler (load jobs, catch up missed, arm timer)
  initScheduler()

  // Seed bundled skills (5 default skills) on first run
  ensureBundledSkills()

  // Initialize sub-agent directory + default config (~/.lucid/subagent/)
  ensureSubagentConfig()
  seedBundledAgents()

  // Connect MCP servers + warm up the LLM HTTP client in the background.
  // These run fire-and-forget so window creation isn't blocked. The first
  // agent run will see MCP tools once init completes (sync getMcpTools()
  // returns [] in the rare race where a message arrives before init finishes).
  void initMcpRuntime()
  const initialModel = readSettings().main.find((m) => m.active)
  if (initialModel) {
    void warmupClient(initialModel)
  }

  // Window control IPC handlers
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) {
      win.unmaximize()
      return false
    }
    win.maximize()
    return true
  })
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle('window:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  // Settings IPC handlers
  ipcMain.handle('settings:read', () => readSettings())
  ipcMain.handle('settings:write', (_event, config: SettingsConfig) => {
    writeSettings(config)
  })
  ipcMain.handle(
    'settings:setActiveModel',
    (_event, category: 'main' | 'multimodal', id: string): SettingsConfig => {
      const config = readSettings()
      const newConfig: SettingsConfig = {
        ...config,
        [category]: config[category].map((m) => ({ ...m, active: m.id === id }))
      }
      writeSettings(newConfig)
      return newConfig
    }
  )
  ipcMain.handle('settings:setSecurityMode', (_event, mode: 'safe' | 'unrestricted'): void => {
    const config = readSettings()
    writeSettings({ ...config, securityMode: mode })
  })

  // Sessions IPC handlers
  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:create', () => {
    const session = createSession()
    return session
  })
  ipcMain.handle('sessions:get', (_event, id: string) => getSessionMessages(id))
  ipcMain.handle(
    'sessions:appendMessage',
    (_event, id: string, role: 'user' | 'assistant', content: string, attachments?: string[]) =>
      appendSessionMessage(id, role, content, 'text', undefined, attachments)
  )
  ipcMain.handle('sessions:delete', (_event, id: string) => {
    clearSessionApprovals(id)
    deleteSession(id)
  })

  // Agent IPC handlers
  ipcMain.handle(
    'agent:run',
    async (
      event,
      sessionId: string,
      content: string,
      attachments?: string[],
      skillSlug?: string,
      expertAgentId?: string
    ) => {
      // If already running → enqueue
      if (isActive(sessionId)) {
        enqueueTask(sessionId, content, attachments)
        const emit = createEmitter(sessionId, event.sender)
        emit('task_queued', {
          queue_depth: getQueueDepth(sessionId),
          mode: 'followup',
          content_preview: content.slice(0, 100)
        })
        return
      }

      // Always use the main model for the agent loop; the vision tool
      // internally calls the multimodal model when image analysis is needed.
      const settings = readSettings()
      const model = settings.main.find((m) => m.active)
      if (!model) {
        const emit = createEmitter(sessionId, event.sender)
        emit('error', {
          error_code: 'NO_MODEL',
          message: '未配置主模型，请先在设置中配置',
          recoverable: false
        })
        return
      }

      const handle = startRun(sessionId)
      const emit = createEmitter(sessionId, event.sender)

      try {
        await runAgent({
          sessionId,
          userMessage: content,
          attachments: attachments,
          model,
          history: getSessionMessages(sessionId),
          emit,
          abortSignal: handle.abortController.signal,
          steerQueue: handle.steerQueue,
          skillSlug,
          expertAgentId
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emit('error', { error_code: 'RUNNER_ERROR', message: msg, recoverable: false })
      } finally {
        endRun(sessionId)
      }

      // Drain queued tasks
      await drainQueuedTasks(sessionId, event.sender)
    }
  )

  // agent:queue — manual enqueue
  ipcMain.handle(
    'agent:queue',
    (event, sessionId: string, content: string, attachments?: string[]) => {
      enqueueTask(sessionId, content, attachments)
      const emit = createEmitter(sessionId, event.sender)
      emit('task_queued', {
        queue_depth: getQueueDepth(sessionId),
        mode: 'followup',
        content_preview: content.slice(0, 100)
      })
    }
  )

  // agent:steer — inject info into running agent, or fall back to followup
  ipcMain.handle('agent:steer', (event, sessionId: string, content: string): { mode: string } => {
    const steered = trySteer(sessionId, content)
    const emit = createEmitter(sessionId, event.sender)
    if (steered) {
      // Remove the matching queued task so it doesn't run again after the agent finishes
      removeFromQueue(sessionId, content)
      emit('task_steered', { run_id: '', content_preview: content.slice(0, 100) })
      return { mode: 'steer' }
    }
    // Fallback: enqueue as followup
    enqueueTask(sessionId, content)
    emit('task_queued', {
      queue_depth: getQueueDepth(sessionId),
      mode: 'followup',
      content_preview: content.slice(0, 100)
    })
    return { mode: 'followup' }
  })

  ipcMain.handle('agent:cancel', (event, sessionId: string) => {
    const cancelled = cancelRun(sessionId)
    if (cancelled) {
      const emit = createEmitter(sessionId, event.sender)
      emit('task_cancelled', { run_id: '', reason: 'user_requested' })
    }
  })

  // agent:isActive — check if a session has an active agent run.
  // Used by the renderer when switching to a session created by a scheduled
  // task to determine if isRunning should be set.
  ipcMain.handle('agent:isActive', (_event, sessionId: string): boolean => {
    return isActive(sessionId)
  })

  // agent:confirmTool — resolve a pending tool confirmation
  ipcMain.handle(
    'agent:confirmTool',
    (
      _event,
      _sessionId: string,
      confirmationId: string,
      action: 'approve_once' | 'approve_session' | 'reject',
      text?: string,
      choiceIndex?: number
    ): boolean => {
      return resolveConfirmation(confirmationId, action, text, choiceIndex)
    }
  )

  // Uploads IPC handlers — save/read base64 data URL to/from disk
  ipcMain.handle(
    'uploads:save',
    (_event, sessionId: string, dataUrl: string, fileName?: string): string => {
      return saveUpload(sessionId, dataUrl, fileName)
    }
  )
  ipcMain.handle('uploads:readAsDataUrl', (_event, filePath: string): string => {
    return readUploadAsDataUrl(filePath)
  })

  // Files IPC — list all workspace files grouped by session
  ipcMain.handle('files:list', () => listWorkspaceFiles())
  ipcMain.handle('files:readText', (_event, filePath: string): string => {
    return readFileText(filePath)
  })
  ipcMain.handle('files:listDir', (_event, sessionId: string, relativePath: string) => {
    return listProductSubDir(sessionId, relativePath)
  })
  ipcMain.handle('shell:showItemInFolder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })
  ipcMain.handle('files:delete', (_event, filePath: string) => {
    deleteFile(filePath)
  })

  // Skills IPC — CRUD + SkillHub search/install
  ipcMain.handle('skills:list', () => listSkills())
  ipcMain.handle('skills:create', (_event, data) => createSkill(data))
  ipcMain.handle('skills:update', (_event, slug: string, data) => updateSkill(slug, data))
  ipcMain.handle('skills:delete', (_event, slug: string) => deleteSkill(slug))
  ipcMain.handle('skills:hubSearch', (_event, query: string) => hubSearch(query))
  ipcMain.handle('skills:hubInstall', (_event, slug: string) => hubInstall(slug))

  // Experts IPC — CRUD (user-created only, no SkillHub)
  ipcMain.handle('experts:list', () => listExperts())
  ipcMain.handle('experts:create', (_event, data) => createExpert(data))
  ipcMain.handle('experts:update', (_event, slug: string, data) => updateExpert(slug, data))
  ipcMain.handle('experts:delete', (_event, slug: string) => deleteExpert(slug))

  // Sub-agent IPC — expert module (list experts, get graph, task runs, session content)
  ipcMain.handle('subagent:listExperts', () => listExposedAgents())
  ipcMain.handle('subagent:getExpert', (_event, agentId: string) => loadAgentDefinition(agentId))
  ipcMain.handle('subagent:getGraph', (_event, agentId: string) => loadAgentGraph(agentId))
  ipcMain.handle('subagent:getTaskRuns', (_event, sessionId: string) =>
    listTaskRunsByParentSession(sessionId)
  )
  ipcMain.handle('subagent:getTaskRun', (_event, runId: string) => getTaskRun(runId))
  ipcMain.handle('subagent:getSessionMessages', (_event, agentId: string, sessionId: string) =>
    getSubagentSessionMessages(agentId, sessionId)
  )

  // MCP IPC — config CRUD + test connection
  // add/update/delete trigger a background reload so the global MCP runtime
  // picks up the new config without restarting the app.
  ipcMain.handle('mcp:getConfig', () => readMcpConfig())
  ipcMain.handle('mcp:addServer', async (_event, name: string, config: McpServerConfig) => {
    const result = mcpAddServer(name, config)
    void reloadMcpRuntime()
    return result
  })
  ipcMain.handle(
    'mcp:updateServer',
    async (_event, name: string, config: Partial<McpServerConfig>) => {
      const result = mcpUpdateServer(name, config)
      void reloadMcpRuntime()
      return result
    }
  )
  ipcMain.handle('mcp:deleteServer', async (_event, name: string) => {
    const result = mcpDeleteServer(name)
    void reloadMcpRuntime()
    return result
  })
  ipcMain.handle('mcp:testServer', (_event, config: McpServerConfig) => testMcpServer(config))

  // Scheduler IPC — CRUD + manual run + status
  ipcMain.handle('scheduler:list', () => listJobs())
  ipcMain.handle('scheduler:add', (_event, input: CronJobCreate) => addJob(input))
  ipcMain.handle('scheduler:update', (_event, id: string, patch: CronJobPatch) =>
    updateJob(id, patch)
  )
  ipcMain.handle('scheduler:remove', (_event, id: string) => removeJob(id))
  ipcMain.handle('scheduler:run', (_event, id: string) => runJobNow(id))
  ipcMain.handle('scheduler:status', () => getStatus())
  ipcMain.handle('scheduler:listRuns', () => listRunRecords())
  ipcMain.handle('scheduler:clearRuns', () => {
    clearRunRecords()
    return true
  })

  // Trace IPC — agent behavior analysis (per-session, per-turn timelines)
  ipcMain.handle('trace:get', (_event, sessionId: string) => getTraces(sessionId))
  ipcMain.handle('trace:getAll', () => getAllTraces())
  ipcMain.handle('trace:clear', (_event, sessionId: string) => {
    clearTraces(sessionId)
    return true
  })

  // Memory IPC — CRUD for the memory database (SQLite + FTS5 + vec0)
  ipcMain.handle('memory:list', () => getAllMemories())
  ipcMain.handle('memory:create', async (_event, content: string, tier: MemoryTier = 'long') => {
    const mem = insertMemory(tier, content, 'manual', 'manual')
    if (mem) {
      const embedding = await getEmbedding(content)
      if (embedding.length > 0) {
        insertVector(mem.id, embedding)
      }
    }
    return mem
  })
  ipcMain.handle(
    'memory:update',
    async (_event, id: string, content: string, tier?: MemoryTier) => {
      const mem = updateMemoryContent(id, content, tier)
      if (mem) {
        const embedding = await getEmbedding(content)
        if (embedding.length > 0) {
          insertVector(mem.id, embedding)
        }
      }
      return mem
    }
  )
  ipcMain.handle('memory:delete', (_event, id: string) => {
    deleteMemory(id)
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  stopScheduler()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Clean up MCP connections on quit. Best-effort — disposeMcpRuntime is async
// but we don't block quit; child processes exit when their stdio pipes close
// as the main process tears down. This runs on Cmd+Q (macOS) and after
// window-all-closed triggers app.quit() (other platforms).
app.on('before-quit', () => {
  void disposeMcpRuntime()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
