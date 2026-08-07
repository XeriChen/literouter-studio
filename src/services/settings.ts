import { getSetting, setSetting } from '../db'

export const DEFAULT_SETTINGS = {
  host: '0.0.0.0',
  port: '3000',
  global_timeout_ms: '120000',
}

export function getSettings(): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = getSetting(key)
    if (value !== null) out[key] = value
  }
  return out
}

export function updateSettings(patch: Partial<Record<string, string>>): Record<string, string> {
  for (const [key, value] of Object.entries(patch)) {
    if (key in DEFAULT_SETTINGS && value !== undefined) setSetting(key, value)
  }
  return getSettings()
}

export function getGlobalTimeoutMs(): number {
  return Number(getSetting('global_timeout_ms') ?? DEFAULT_SETTINGS.global_timeout_ms)
}