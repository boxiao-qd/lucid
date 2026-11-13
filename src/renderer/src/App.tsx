import { useEffect } from 'react'
import Sidebar from './components/sidebar/Sidebar'
import ChatView from './components/ChatView'
import MyFiles from './components/MyFiles'
import MySkills from './components/MySkills'
import AgentExtensions from './components/AgentExtensions'
import ScheduledTasks from './components/ScheduledTasks'
import AgentTrace from './components/AgentTrace'
import ExecutionView from './components/ExecutionView'
import WindowControls from './components/WindowControls'
import BrowserPanel from './components/BrowserPanel'
import { useSessionStore } from './store/sessionStore'
import { useAgentStore } from './store/agentStore'
import { useSettingsStore } from './store/settingsStore'
import { useSkillStore } from './store/skillStore'
import { useUIStore } from './store/uiStore'
import { useBrowserStore } from './store/browserStore'

function App(): React.JSX.Element {
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const loadModels = useSettingsStore((s) => s.loadModels)
  const loadSkills = useSkillStore((s) => s.load)
  const view = useUIStore((s) => s.view)
  const browserOpen = useBrowserStore((s) => s.isOpen)
  const browserSessionId = useBrowserStore((s) => s.sessionId)
  const browserExpanded = useBrowserStore((s) => s.expanded)
  const currentId = useSessionStore((s) => s.currentId)

  // The browser panel belongs to the session that opened it. When the user
  // switches sessions or creates a new task (currentId changes), close the
  // panel if it's showing another session's browser. Unmounting BrowserPanel
  // detaches the guest via its cleanup, so the main process frees that
  // session's browser too. A background agent that needs the browser again
  // simply re-opens it (browser_open re-fires on the next browser_use call).
  useEffect(() => {
    const { isOpen, sessionId } = useBrowserStore.getState()
    if (isOpen && sessionId && sessionId !== currentId) {
      useBrowserStore.getState().close()
    }
  }, [currentId])

  useEffect(() => {
    // Register the agent event listener once — routes IPC events to agentStore.
    // Events from scheduled task runs carry their own sessionId; we only apply
    // them to the agentStore when they match the currently viewed session, so
    // background runs don't leak streaming state into an unrelated conversation.
    const off = window.api.agent.onEvent((env) => {
      const { currentId } = useSessionStore.getState()
      const isCurrent = env.sessionId === currentId

      if (env.type === 'user_message_added') {
        const data = env.data as { id: string; role: 'user'; content: string; createdAt: number }
        // Remove from local queue — this task has been dequeued and is starting
        useAgentStore.getState().removeFromQueue(data.content)
        // Only append to the messages list if the user is viewing this session
        if (isCurrent) {
          useSessionStore.setState((s) => ({
            messages: [
              ...s.messages,
              {
                id: data.id,
                role: data.role,
                content: data.content,
                createdAt: data.createdAt,
                type: 'text' as const
              }
            ]
          }))
        }
        return
      }

      // tool_confirm_resolved: always forward, regardless of isCurrent.
      // When the user responds via the overlay window, the inline
      // ToolConfirmDialog needs to be cleared even if the user has
      // switched to a different session.
      if (env.type === 'tool_confirm_resolved') {
        useAgentStore.getState().handleEvent(env)
        return
      }

      // Browser panel open/close events — always forward so the panel
      // opens/closes even if the user switched sessions mid-run.
      if (env.type === 'browser_open') {
        const data = env.data as { sessionId: string }
        useBrowserStore.getState().open(data.sessionId)
        return
      }
      if (env.type === 'browser_closed') {
        // Only close the panel if the event is for the session it shows —
        // another session's browser closing shouldn't hide this one.
        const data = env.data as { sessionId: string }
        if (data.sessionId === useBrowserStore.getState().sessionId) {
          useBrowserStore.getState().close()
        }
        return
      }

      // Only forward agent events (streaming, tool calls, etc.) to the
      // agentStore when the user is viewing the matching session.
      if (isCurrent) {
        useAgentStore.getState().handleEvent(env)
      }
    })
    return off
  }, [])

  useEffect(() => {
    void Promise.all([loadSessions(), loadModels(), loadSkills()])
  }, [loadSessions, loadModels, loadSkills])

  // Poll for session list changes — scheduled tasks create sessions in the
  // background and the sidebar needs to reflect them without a manual refresh.
  useEffect(() => {
    const interval = setInterval(() => {
      void loadSessions()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadSessions])

  // Poll for message changes in the current session — when a scheduled task
  // is running in the background and writing to the JSONL, this picks up new
  // messages so they appear even without matching SSE events (e.g. the user
  // clicked into the session mid-run after some messages were already written).
  // Skip when the agent is actively running on the current session — real-time
  // events handle UI updates, and polling would cause duplicate rendering of
  // thinking/tool_call messages (both persisted and live in agentStore).
  useEffect(() => {
    const interval = setInterval(() => {
      const { currentId, messages } = useSessionStore.getState()
      if (!currentId) return
      if (useAgentStore.getState().isRunning) return
      void window.api.sessions.get(currentId).then((msgs) => {
        if (msgs.length !== messages.length) {
          useSessionStore.setState({ messages: msgs })
        }
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white text-stone-900">
      <div
        className="flex h-9 flex-shrink-0 items-center justify-end bg-stone-50"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <WindowControls />
      </div>
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        {view === 'files' ? (
          <MyFiles />
        ) : view === 'skills' ? (
          <MySkills />
        ) : view === 'extensions' ? (
          <AgentExtensions />
        ) : view === 'scheduled-tasks' ? (
          <ScheduledTasks />
        ) : view === 'trace' ? (
          <AgentTrace />
        ) : view === 'execution' ? (
          <ExecutionView />
        ) : (
          <div className="flex flex-1 overflow-hidden">
            {/* Chat is hidden when the browser panel is in full-width mode. */}
            <div className={browserOpen && browserExpanded ? 'hidden' : 'flex-1 overflow-hidden'}>
              <ChatView />
            </div>
            {browserOpen && browserSessionId && <BrowserPanel sessionId={browserSessionId} />}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
