import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import type { SettingsConfig, ModelConfig, SecurityMode } from '../shared/types'
import { getDefaultSettings, normalizeSettings } from '../shared/types'

const SETTINGS_DIR = join(homedir(), '.lucid')
const SETTINGS_FILE = join(SETTINGS_DIR, 'setting.json')

export function readSettings(): SettingsConfig {
  const defaults = getDefaultSettings()
  try {
    if (!existsSync(SETTINGS_FILE)) {
      return defaults
    }
    const raw = readFileSync(SETTINGS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SettingsConfig>
    // Fall back to defaults for any missing or empty category, so a fresh
    // install (or an existing user with empty arrays) always has working models.
    const fillDefaults = (list: unknown, fallback: ModelConfig[]): ModelConfig[] =>
      Array.isArray(list) && list.length > 0 ? (list as ModelConfig[]) : fallback
    return {
      main: fillDefaults(parsed.main, defaults.main),
      auxiliary: fillDefaults(parsed.auxiliary, defaults.auxiliary),
      multimodal: fillDefaults(parsed.multimodal, defaults.multimodal),
      imageGen: fillDefaults(parsed.imageGen, defaults.imageGen),
      securityMode:
        parsed.securityMode === 'unrestricted' ? 'unrestricted' : ('safe' as SecurityMode)
    }
  } catch {
    return defaults
  }
}

export function writeSettings(config: SettingsConfig): void {
  const normalized = normalizeSettings(config)
  mkdirSync(SETTINGS_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(normalized, null, 2), 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(SETTINGS_DIR, 0o700)
    chmodSync(SETTINGS_FILE, 0o600)
  }
}
