// MCP runtime — app-level singleton (ported from dsh pattern).
//
// Connects to all configured MCP servers ONCE at app startup, reuses the
// persistent Client instances across every agent run. Tool execute closures
// capture the persistent Client, so each tool call reuses the same
// long-lived stdio/HTTP connection — no per-run spawn + handshake + listTools.
//
// Lifecycle:
//   initMcpRuntime()     → app ready: parallel connect + discover + register
//   getMcpTools()        → sync read from the global registry (agent run path)
//   reloadMcpRuntime()   → config changed: dispose + re-init
//   disposeMcpRuntime()  → app quit: close all clients
//   testMcpServer(config) → one-off connection test for UI (independent client)
//
// Concurrency: init is idempotent and reuses the in-flight promise. reload
// marks a pending flag and lets the current cycle finish before starting a
// new one, so rapid config edits serialize naturally.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpToolInfo } from '../../shared/types'
import type { ToolDef, ToolExecContext } from '../agent/tool-def'
import { readMcpConfig } from './mcp-config'

const MCP_TIMEOUT_MS = 30_000

// Merge process.env with server-specific env, filtering out undefined values.
// process.env has Record<string, string | undefined>, but StdioClientTransport
// expects Record<string, string>.
function mergeEnv(serverEnv?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) result[key] = val
  }
  if (serverEnv) {
    for (const [key, val] of Object.entries(serverEnv)) {
      result[key] = val
    }
  }
  return result
}

interface ServerEntry {
  serverName: string
  client: Client
  tools: ToolDef[]
}

interface GlobalMcpRuntime {
  servers: Map<string, ServerEntry>
}

let RUNTIME: GlobalMcpRuntime | null = null
let currentInit: Promise<void> | null = null
let pendingReload = false

// Wrap an MCP tool as a ToolDef. The execute closure captures the persistent
// `client` — every tool call reuses the same long-lived connection established
// at startup, exactly like dsh's createDefinition/createExecutor pattern.
function wrapMcpTool(
  serverName: string,
  tool: {
    name: string
    description?: string
    inputSchema?: Record<string, unknown>
  },
  client: Client
): ToolDef {
  const fullName = `${serverName}__${tool.name}`
  return {
    name: fullName,
    openai: {
      type: 'function',
      function: {
        name: fullName,
        description: tool.description || `MCP tool: ${tool.name} (from ${serverName})`,
        parameters: tool.inputSchema || { type: 'object', properties: {} }
      }
    },
    execute: async (argsStr: string, _ctx: ToolExecContext): Promise<string> => {
      let args: Record<string, unknown>
      try {
        args = JSON.parse(argsStr)
      } catch {
        return JSON.stringify({ error: 'Invalid JSON arguments for MCP tool' })
      }

      try {
        const result = await client.callTool({ name: tool.name, arguments: args })
        // Extract text content blocks and join them
        const content =
          (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
        const textParts = content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text!)
        const output = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(result)
        return JSON.stringify({ result: output })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify({ error: `MCP tool ${tool.name} failed: ${msg}` })
      }
    }
  }
}

// Connect to a single MCP server and discover its tools.
// Returns null on failure (error logged, caller continues with other servers).
async function connectServer(
  serverName: string,
  config: McpServerConfig
): Promise<ServerEntry | null> {
  let client: Client | null = null
  try {
    client = new Client({ name: 'lucid-mcp', version: '0.0.0' }, { capabilities: {} })

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: mergeEnv(config.env),
      stderr: 'pipe'
    })

    // Race connect against a timeout
    await Promise.race([
      client.connect(transport),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error(`MCP server "${serverName}" connection timeout`)),
          MCP_TIMEOUT_MS
        )
      )
    ])

    const { tools: mcpTools } = await client.listTools()
    const tools = mcpTools.map((t) => wrapMcpTool(serverName, t, client!))
    console.log(`[MCP] Connected to "${serverName}", discovered ${mcpTools.length} tools`)
    return { serverName, client, tools }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[MCP] Failed to connect to "${serverName}": ${msg}`)
    if (client) {
      try {
        await client.close()
      } catch {
        // ignore — best-effort cleanup
      }
    }
    return null
  }
}

// Single init cycle: dispose old runtime, connect all servers IN PARALLEL,
// store successful entries in the global RUNTIME map. Individual server
// failures are logged but don't block the others (Promise.allSettled).
async function runInitCycle(): Promise<void> {
  await disposeMcpRuntime()

  const config = readMcpConfig()
  const entries = Object.entries(config.servers)

  if (entries.length === 0) {
    RUNTIME = { servers: new Map() }
    return
  }

  const results = await Promise.allSettled(
    entries.map(([name, serverConfig]) => connectServer(name, serverConfig))
  )

  const servers = new Map<string, ServerEntry>()
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      servers.set(r.value.serverName, r.value)
    }
  }
  RUNTIME = { servers }
}

// Initialize the global MCP runtime. Idempotent — if an init cycle is already
// in flight, returns the same promise. Call once from app.whenReady.
export function initMcpRuntime(): Promise<void> {
  if (currentInit) return currentInit
  currentInit = runInitCycle().finally(() => {
    currentInit = null
    // If reload was requested during this cycle, kick off a new one.
    if (pendingReload) {
      pendingReload = false
      initMcpRuntime()
    }
  })
  return currentInit
}

// Reload after config change. If an init cycle is running, let it finish
// (marking pendingReload) and then run a fresh cycle. If idle, run immediately.
// Fire-and-forget from the caller's perspective — UI does not wait on this.
export function reloadMcpRuntime(): Promise<void> {
  if (currentInit) {
    pendingReload = true
    return currentInit
  }
  return initMcpRuntime()
}

// Sync read of all currently-registered MCP tools. Called on every agent run
// — must be O(tools) and never spawn a process. Returns [] if runtime isn't
// initialized yet (e.g. a run that starts before init finishes — agent will
// see no MCP tools for that run, which is an acceptable degradation).
export function getMcpTools(): ToolDef[] {
  if (!RUNTIME) return []
  const all: ToolDef[] = []
  for (const entry of RUNTIME.servers.values()) {
    for (const t of entry.tools) all.push(t)
  }
  return all
}

// Close all connected clients and drop the runtime. Safe to call when not
// initialized. Called on app quit and at the start of each init cycle.
export async function disposeMcpRuntime(): Promise<void> {
  if (!RUNTIME) return
  const old = RUNTIME
  RUNTIME = null
  for (const entry of old.servers.values()) {
    try {
      await entry.client.close()
    } catch {
      // ignore — best-effort cleanup
    }
  }
}

// Test a single MCP server connection — used by the UI "test connection" button.
// Creates a temporary client, lists tools, and closes. Independent of the
// global runtime.
export async function testMcpServer(
  config: McpServerConfig
): Promise<{ tools: McpToolInfo[]; error?: string }> {
  let client: Client | null = null
  try {
    client = new Client({ name: 'lucid-mcp-test', version: '0.0.0' }, { capabilities: {} })

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: mergeEnv(config.env),
      stderr: 'pipe'
    })

    await Promise.race([
      client.connect(transport),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), MCP_TIMEOUT_MS)
      )
    ])

    const { tools: mcpTools } = await client.listTools()
    const toolInfos: McpToolInfo[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined
    }))

    return { tools: toolInfos }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { tools: [], error: msg }
  } finally {
    if (client) {
      try {
        await client.close()
      } catch {
        // ignore
      }
    }
  }
}
