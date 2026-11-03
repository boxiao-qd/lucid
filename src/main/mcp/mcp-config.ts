// MCP config management — reads/writes ~/.lucid/mcp.json.
// Pre-seeds a Notion MCP server with default configuration
// on first run so the user has a working MCP capability out of the box.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { McpConfig, McpServerConfig } from '../../shared/types'

const LUCID_DIR = join(homedir(), '.lucid')
const MCP_CONFIG_PATH = join(LUCID_DIR, 'mcp.json')

// Default config — empty. Users add MCP servers via the UI; config persists to ~/.lucid/mcp.json.
const DEFAULT_CONFIG: McpConfig = {
  servers: {}
}

export function readMcpConfig(): McpConfig {
  if (!existsSync(MCP_CONFIG_PATH)) {
    mkdirSync(LUCID_DIR, { recursive: true })
    writeFileSync(MCP_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
    return DEFAULT_CONFIG
  }
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as McpConfig
    if (!parsed.servers || typeof parsed.servers !== 'object') {
      return DEFAULT_CONFIG
    }
    return parsed
  } catch {
    return DEFAULT_CONFIG
  }
}

export function writeMcpConfig(config: McpConfig): void {
  mkdirSync(LUCID_DIR, { recursive: true })
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

export function addServer(name: string, config: McpServerConfig): McpConfig {
  const current = readMcpConfig()
  current.servers[name] = config
  writeMcpConfig(current)
  return current
}

export function updateServer(name: string, config: Partial<McpServerConfig>): McpConfig {
  const current = readMcpConfig()
  if (!current.servers[name]) {
    throw new Error(`MCP server not found: ${name}`)
  }
  current.servers[name] = { ...current.servers[name], ...config }
  writeMcpConfig(current)
  return current
}

export function deleteServer(name: string): McpConfig {
  const current = readMcpConfig()
  delete current.servers[name]
  writeMcpConfig(current)
  return current
}
