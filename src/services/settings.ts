import { getSetting, setSetting } from '../db'

export const DEFAULT_SETTINGS = {
  host: '0.0.0.0',
  port: '3000',
  global_timeout_ms: '120000',
  log_retention_days: '30',
}

export type SettingsKey = keyof typeof DEFAULT_SETTINGS
type NumericSettingKey = 'global_timeout_ms' | 'log_retention_days'

export function getSettings(): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = getSetting(key)
    if (value !== null) out[key] = value
  }
  return out
}

export function updateSettings(patch: Partial<Record<SettingsKey, string>>): Record<string, string> {
  for (const [key, value] of Object.entries(patch)) {
    if (key in DEFAULT_SETTINGS && value !== undefined) setSetting(key, value)
  }
  return getSettings()
}

export function getGlobalTimeoutMs(): number {
  return getNonNegativeInteger('global_timeout_ms')
}

export function getLogRetentionDays(): number {
  return getNonNegativeInteger('log_retention_days')
}

function getNonNegativeInteger(key: NumericSettingKey): number {
  const value = Number(getSetting(key) ?? DEFAULT_SETTINGS[key])
  return Number.isSafeInteger(value) && value >= 0 ? value : Number(DEFAULT_SETTINGS[key])
}
