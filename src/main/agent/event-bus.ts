import type { WebContents } from 'electron'
import type { AgentEventEnvelope, AgentEventType } from '../../shared/agent-events'

export type Emit = (type: AgentEventType, data: Record<string, unknown>) => void

// Bind a sessionId + webContents to a send callback. The agent runner calls
// emit(type, data) and the envelope is shipped over the `agent:event` IPC channel.
export function createEmitter(sessionId: string, webContents: WebContents): Emit {
  return (type, data) => {
    const envelope: AgentEventEnvelope = { type, sessionId, timestamp: Date.now(), data }
    webContents.send('agent:event', envelope)
  }
}
