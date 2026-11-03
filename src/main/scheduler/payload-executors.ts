// Payload executors — route job payload to the right executor.
// agentTurn: create session + run agent. command: spawn child process.
// memoryConsolidate: call memory consolidation function.

import { spawn } from 'node:child_process'
import { BrowserWindow } from 'electron'
import type { CronJob, CronRunOutcome } from './types'
import { consolidateMemories } from '../memory/memory-consolidate'
import { createSession, appendSessionMessage, getSessionMessages } from '../sessions'
import { runAgent } from '../agent/agent-runner'
import { readSettings } from '../settings'
import { listProducts } from '../uploads'
import { createEmitter } from '../agent/event-bus'
import { startRun, endRun } from '../agent/active-runs'
import type { Emit } from '../agent/event-bus'

// Main entry: route by payload kind
export async function executePayload(job: CronJob): Promise<CronRunOutcome> {
  const start = Date.now()
  try {
    switch (job.payload.kind) {
      case 'agentTurn':
        return await executeAgentTurn(job, start)
      case 'command':
        return await executeCommand(job, start)
      case 'memoryConsolidate':
        return await executeMemoryConsolidate(start)
    }
  } catch (e) {
    return {
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start
    }
  }
}

// agentTurn: create a new session, append the user message, run the agent.
// The agent runs to completion — results are persisted in the session JSONL.
// No renderer forwarding (scheduled runs happen in background).
async function executeAgentTurn(job: CronJob, start: number): Promise<CronRunOutcome> {
  if (job.payload.kind !== 'agentTurn') {
    return {
      status: 'error',
      error: 'Not an agentTurn payload',
      durationMs: Date.now() - start
    }
  }
  const { message } = job.payload
  const session = createSession()
  const settings = readSettings()
  const model = settings.main.find((m) => m.active) ?? settings.main[0]
  if (!model) {
    return {
      status: 'error',
      error: 'No main model configured',
      sessionId: session.id,
      durationMs: Date.now() - start
    }
  }

  // Get the main window's WebContents to forward agent events to the renderer.
  // This allows the user to see the live execution process when they click
  // into the scheduled task's session.
  const win = BrowserWindow.getAllWindows()[0]
  const emit: Emit = win
    ? createEmitter(session.id, win.webContents)
    : (_type, _data) => {
        // No window — silently drop events
      }

  // Register as an active run so isActive(sessionId) returns true —
  // the renderer uses this to set isRunning when the user clicks in.
  const handle = startRun(session.id)

  // Append the user message to the session before running the agent
  appendSessionMessage(session.id, 'user', message, 'text')

  // Load session history (will include the just-appended user message)
  const history = getSessionMessages(session.id)

  try {
    await runAgent({
      sessionId: session.id,
      userMessage: message,
      attachments: [],
      model,
      history,
      emit,
      abortSignal: handle.abortController.signal
    })
  } finally {
    endRun(session.id)
  }

  // Capture results for the execution record:
  // 1. Extract the agent's final text response from the session
  const messages = getSessionMessages(session.id)
  let resultText: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.type === 'text' && msg.content.trim()) {
      resultText = msg.content.length > 5000 ? msg.content.slice(0, 5000) + '…' : msg.content
      break
    }
  }

  // 2. Scan the product directory for files created during this run
  const products = listProducts(session.id)
  const productFiles = products.length > 0 ? products.map((p) => p.path) : undefined

  return {
    status: 'ok',
    sessionId: session.id,
    resultText,
    productFiles,
    durationMs: Date.now() - start
  }
}

// command: spawn a child process with argv, cwd, env, timeout
async function executeCommand(job: CronJob, start: number): Promise<CronRunOutcome> {
  if (job.payload.kind !== 'command') {
    return {
      status: 'error',
      error: 'Not a command payload',
      durationMs: Date.now() - start
    }
  }
  const { argv, cwd, env, timeoutSeconds = 300 } = job.payload

  if (!argv || argv.length === 0) {
    return {
      status: 'error',
      error: 'Empty command argv',
      durationMs: Date.now() - start
    }
  }

  return new Promise((resolve) => {
    const proc = spawn(argv[0], argv.slice(1), {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, ...env },
      timeout: timeoutSeconds * 1000,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    proc.on('close', (code) => {
      resolve({
        status: code === 0 ? 'ok' : 'error',
        exitCode: code ?? -1,
        error: code !== 0 ? stderr.slice(0, 2000) || `Exit code ${code}` : undefined,
        resultText: stdout
          ? stdout.length > 5000
            ? stdout.slice(0, 5000) + '…'
            : stdout
          : undefined,
        durationMs: Date.now() - start
      })
    })

    proc.on('error', (err) => {
      resolve({
        status: 'error',
        error: err.message,
        durationMs: Date.now() - start
      })
    })
  })
}

// memoryConsolidate: call the memory consolidation function directly
async function executeMemoryConsolidate(start: number): Promise<CronRunOutcome> {
  try {
    await consolidateMemories()
    return { status: 'ok', durationMs: Date.now() - start }
  } catch (e) {
    return {
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start
    }
  }
}
