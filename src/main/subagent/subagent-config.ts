// Sub-agent global config — reads ~/.lucid/subagent/config.json.
//
// Holds the global tool deny list (applied to all sub-agents in addition to
// per-agent deny) and default maxTurns. Missing file → sensible defaults.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import type { SubagentConfig } from '../../shared/subagent-types'

const LUCID_DIR = join(homedir(), '.lucid')
export const SUBAGENT_DIR = join(LUCID_DIR, 'subagent')
const CONFIG_FILE = join(SUBAGENT_DIR, 'config.json')

const DEFAULT_CONFIG: SubagentConfig = {
  version: 1,
  globalTools: {
    // session_spawn is always denied for sub-agents — no nested spawning.
    deny: ['session_spawn']
  },
  defaults: {
    maxTurns: 90
  }
}

export function ensureSubagentDir(): void {
  mkdirSync(SUBAGENT_DIR, { recursive: true })
  if (process.platform !== 'win32') {
    chmodSync(SUBAGENT_DIR, 0o700)
  }
}

export function loadSubagentConfig(): SubagentConfig {
  if (!existsSync(CONFIG_FILE)) {
    return structuredClone(DEFAULT_CONFIG)
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SubagentConfig>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      globalTools: {
        deny: Array.isArray(parsed.globalTools?.deny)
          ? parsed.globalTools!.deny
          : DEFAULT_CONFIG.globalTools.deny
      },
      defaults: {
        maxTurns:
          typeof parsed.defaults?.maxTurns === 'number'
            ? parsed.defaults.maxTurns
            : DEFAULT_CONFIG.defaults.maxTurns
      }
    }
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveSubagentConfig(config: SubagentConfig): void {
  ensureSubagentDir()
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(CONFIG_FILE, 0o600)
  }
}

/** Ensure the default config exists on disk so the subagent dir is bootstrapped. */
export function ensureSubagentConfig(): void {
  ensureSubagentDir()
  if (!existsSync(CONFIG_FILE)) {
    saveSubagentConfig(DEFAULT_CONFIG)
  }
}

export { DEFAULT_CONFIG }
