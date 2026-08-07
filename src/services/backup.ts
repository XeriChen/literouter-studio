import { db } from '../db'
import { getAdminToken, setAdminToken } from './auth'
import { getSettings, updateSettings } from './settings'
import { parseAuth, parseCustomHeaders } from '../providers/headers'
import type { ProviderRow } from '../types'

export interface BackupData {
  token: string
  settings: Record<string, string>
  providers: Array<{
    id: string
    name: string
    protocol: 'openai' | 'anthropic'
    base_url: string
    auth: Record<string, string>
    custom_headers: Record<string, string>
    proxy_url: string | null
    timeout_ms: number | null
    enabled: number
    created_at: string
    updated_at: string
  }>
  models: Array<{
    provider_id: string
    model_id: string
    display_name: string | null
    enabled: number
    source: 'fetched' | 'manual'
  }>
}

export function exportBackup(): BackupData {
  const providers = (db.prepare('SELECT * FROM providers').all() as ProviderRow[]).map((p) => ({
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    base_url: p.base_url,
    auth: parseAuth(p),
    custom_headers: parseCustomHeaders(p),
    proxy_url: p.proxy_url,
    timeout_ms: p.timeout_ms,
    enabled: p.enabled,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }))
  const models = db
    .prepare('SELECT provider_id, model_id, display_name, enabled, source FROM provider_models')
    .all() as BackupData['models']
  return {
    token: getAdminToken(),
    settings: getSettings(),
    providers,
    models,
  }
}

export function importBackup(data: BackupData): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM providers').run()
    const insertProvider = db.prepare(
      `INSERT INTO providers (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, enabled, created_at, updated_at)
       VALUES (@id, @name, @protocol, @base_url, @auth_json, @custom_headers_json, @proxy_url, @timeout_ms, @enabled, @created_at, @updated_at)`,
    )
    for (const p of data.providers) {
      insertProvider.run({
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        base_url: p.base_url,
        auth_json: JSON.stringify(p.auth),
        custom_headers_json: JSON.stringify(p.custom_headers),
        proxy_url: p.proxy_url,
        timeout_ms: p.timeout_ms,
        enabled: p.enabled,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })
    }
    const insertModel = db.prepare(
      `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = new Date().toISOString()
    for (const m of data.models) {
      insertModel.run(m.provider_id, m.model_id, m.display_name, m.enabled, m.source, now, now)
    }
    setAdminToken(data.token)
    updateSettings(data.settings)
  })
  tx()
}