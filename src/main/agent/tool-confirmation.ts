// Tool confirmation store — user confirmation mechanism for dangerous tools.
// Provides a user-confirmation mechanism for dangerous tools (code_execute,
// terminal). Before executing, the tool calls requestConfirmation() which
// emits a tool_confirm_request event to the renderer AND shows a system-wide
// overlay window (alwaysOnTop BrowserWindow at top-right of screen).
// The user can respond via either the overlay or the inline ToolConfirmDialog.
// When resolved, the overlay is closed and a tool_confirm_resolved event is
// emitted to clear the inline dialog. A 5-minute timeout auto-rejects.

import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { Emit } from './event-bus'
import type { ToolConfirmChoice, ToolConfirmCommandBlock } from '../../shared/agent-events'
import { showConfirmWindow, closeConfirmWindow } from './confirm-window'
import { readSettings } from '../settings'

/**
 * Check if the Lucid main window is focused (in the foreground).
 * When true, inline confirmations in the chat dialog are visible to the
 * user and the top-right overlay is redundant. When false (user is in
 * another app), the overlay is needed to alert the user.
 */
function isLucidFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow()
  // getFocusedWindow returns null when no app window has focus (user is in
  // another app). Exclude the confirm overlay itself (alwaysOnTop) in case
  // a stale window lingers.
  return !!focused && !focused.isAlwaysOnTop()
}

export type ConfirmAction = 'approve_once' | 'approve_session' | 'reject'

export interface ConfirmationResult {
  action: ConfirmAction
  text?: string
  /** For choices mode: the index of the selected choice (0-based) */
  choiceIndex?: number
}

interface PendingConfirmation {
  id: string
  sessionId: string
  toolName: string
  toolCallId: string
  /** Emit function — used to send tool_confirm_resolved to the renderer
  when the confirmation is resolved, so the inline dialog can be cleared. */
  emit: Emit
  resolve: (result: ConfirmationResult) => void
  timer: ReturnType<typeof setTimeout>
}

// confirmation_id → pending entry
const PENDING = new Map<string, PendingConfirmation>()

// sessionId → set of tool names approved for the entire session
const SESSION_APPROVALS = new Map<string, Set<string>>()

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// Tools that auto-approve in unrestricted mode (skip all confirmation UI).
// `ask_user` is NOT included — it is a question, not a safety check.
const UNRESTRICTED_TOOLS = new Set(['terminal', 'code_execute', 'shell_execute'])

// Check if a tool has been approved for the session (via approve_session).
// If so, skip the confirmation prompt entirely.
export function isToolApproved(sessionId: string, toolName: string): boolean {
  return SESSION_APPROVALS.get(sessionId)?.has(toolName) ?? false
}

// Mark a tool as approved for the rest of the session.
export function approveToolForSession(sessionId: string, toolName: string): void {
  let set = SESSION_APPROVALS.get(sessionId)
  if (!set) {
    set = new Set()
    SESSION_APPROVALS.set(sessionId, set)
  }
  set.add(toolName)
}

// Clear session approvals (called when a session ends or is reset).
export function clearSessionApprovals(sessionId: string): void {
  SESSION_APPROVALS.delete(sessionId)
}

// Request user confirmation before executing a dangerous tool.
// Emits a tool_confirm_request event and returns a Promise that resolves
// when the user responds (via resolveConfirmation) or after 5 minutes.
export function requestConfirmation(
  sessionId: string,
  toolName: string,
  content: string,
  toolCallId: string | undefined,
  emit: Emit,
  abortSignal?: AbortSignal,
  choices?: ToolConfirmChoice[],
  commandBlocks?: ToolConfirmCommandBlock[],
  isSubagent?: boolean,
  purpose?: string
): Promise<ConfirmationResult> {
  // Unrestricted mode: auto-approve dangerous tools without any UI.
  if (UNRESTRICTED_TOOLS.has(toolName)) {
    if (readSettings().securityMode === 'unrestricted') {
      return Promise.resolve({ action: 'approve_once' })
    }
  }

  const confirmationId = randomUUID()

  return new Promise<ConfirmationResult>((resolve) => {
    const timer = setTimeout(() => {
      PENDING.delete(confirmationId)
      closeConfirmWindow()
      resolve({ action: 'reject', text: '确认超时（5 分钟未响应），已自动拒绝' })
    }, CONFIRM_TIMEOUT_MS)

    PENDING.set(confirmationId, {
      id: confirmationId,
      sessionId,
      toolName,
      toolCallId: toolCallId ?? '',
      emit,
      resolve,
      timer
    })

    // Decide which confirmation UI to use — overlay or inline dialog, never both.
    //   - Sub-agent: always overlay (inline is blocked by agentStore's agentId guard)
    //   - Main agent, Lucid focused: inline dialog only
    //   - Main agent, Lucid not focused: overlay only
    // When the overlay is shown, we skip emitting tool_confirm_request so the
    // inline dialog doesn't also appear when the user switches back to Lucid.
    const shouldShowOverlay = isSubagent || !isLucidFocused()

    if (shouldShowOverlay) {
      showConfirmWindow({
        confirmationId,
        sessionId,
        toolName,
        content,
        choices: choices && choices.length > 0 ? choices : undefined,
        commandBlocks: commandBlocks && commandBlocks.length > 0 ? commandBlocks : undefined,
        purpose
      })
    } else {
      // Emit event to renderer — the inline ToolConfirmDialog (in ChatView)
      // will show if the user is viewing the matching session.
      const eventData: Record<string, unknown> = {
        confirmation_id: confirmationId,
        tool_name: toolName,
        tool_call_id: toolCallId ?? '',
        content
      }
      if (choices && choices.length > 0) {
        eventData.choices = choices
      }
      if (commandBlocks && commandBlocks.length > 0) {
        eventData.command_blocks = commandBlocks
      }
      if (purpose) {
        eventData.purpose = purpose
      }
      emit('tool_confirm_request', eventData)
    }

    // If the agent run is aborted, auto-reject
    if (abortSignal) {
      const onAbort = (): void => {
        const entry = PENDING.get(confirmationId)
        if (entry) {
          clearTimeout(entry.timer)
          PENDING.delete(confirmationId)
          closeConfirmWindow()
          resolve({ action: 'reject', text: '任务已取消' })
        }
      }
      if (abortSignal.aborted) {
        onAbort()
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    }
  })
}

// Resolve a pending confirmation — called from the IPC handler when the
// user clicks approve_once / approve_session / reject in either the overlay
// window or the inline ToolConfirmDialog.
export function resolveConfirmation(
  confirmationId: string,
  action: ConfirmAction,
  text?: string,
  choiceIndex?: number
): boolean {
  const entry = PENDING.get(confirmationId)
  if (!entry) return false

  clearTimeout(entry.timer)
  PENDING.delete(confirmationId)

  if (action === 'approve_session') {
    approveToolForSession(entry.sessionId, entry.toolName)
  }

  // Close the system-wide overlay window (no-op if already closed)
  closeConfirmWindow()

  // Notify the renderer to clear the inline ToolConfirmDialog — this
  // works even when the user responded via the overlay window.
  entry.emit('tool_confirm_resolved', {
    confirmation_id: confirmationId,
    action
  })

  entry.resolve({ action, text, choiceIndex })
  return true
}
