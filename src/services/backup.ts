import { db } from '../db'
import { getAdminToken, setAdminToken } from './auth'
import { getSettings, updateSettings, type SettingsKey } from './settings'
import { parseAuth, parseCustomHeaders } from '../providers/headers'
import { invalidateAllDispatchers } from '../proxy'
import type { ProviderRow } from '../types'

export interface BackupData {
  token: string
  settings: Partial<Record<SettingsKey, string>>
  providers: Array<{
    id: string
    name: string
    protocol: 'openai' | 'anthropic'
    base_url: string
    auth: Record<string, string>
    custom_headers: Record<string, string>
    proxy_url: string | null
    timeout_ms: number | null
    model_filter: string | null
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
  aliases: Array<{
    protocol: 'openai' | 'anthropic'
    alias_name: string
    provider_id: string
    model_id: string
  }>
}

function validateBackupGraph(data: BackupData): void {
  const providers = new Map<string, BackupData['providers'][number]>()
  for (const provider of data.providers) {
    if (providers.has(provider.id)) throw new Error(`duplicate provider id: ${provider.id}`)
    providers.set(provider.id, provider)
  }

  const models = new Map<string, Set<string>>()
  for (const model of data.models) {
    if (!providers.has(model.provider_id)) throw new Error(`model provider not found: ${model.provider_id}`)
    const providerModels = models.get(model.provider_id) ?? new Set<string>()
    if (providerModels.has(model.model_id)) {
      throw new Error(`duplicate model: ${model.provider_id}/${model.model_id}`)
    }
    providerModels.add(model.model_id)
    models.set(model.provider_id, providerModels)
  }

  const aliases = new Set<string>()
  for (const alias of data.aliases) {
    const key = JSON.stringify([alias.protocol, alias.alias_name])
    if (aliases.has(key)) throw new Error(`duplicate alias: ${alias.protocol}/${alias.alias_name}`)
    aliases.add(key)

    const provider = providers.get(alias.provider_id)
    if (!provider) throw new Error(`alias provider not found: ${alias.provider_id}`)
    if (provider.protocol !== alias.protocol) {
      throw new Error(`alias protocol mismatch: ${alias.protocol}/${alias.alias_name}`)
    }
    if (!models.get(alias.provider_id)?.has(alias.model_id)) {
      throw new Error(`alias model not found: ${alias.provider_id}/${alias.model_id}`)
    }
  }
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
    model_filter: p.model_filter,
    enabled: p.enabled,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }))
  const models = db
    .prepare('SELECT provider_id, model_id, display_name, enabled, source FROM provider_models')
    .all() as BackupData['models']
  const aliases = db
    .prepare('SELECT protocol, alias_name, provider_id, model_id FROM model_aliases')
    .all() as BackupData['aliases']
  return {
    token: getAdminToken(),
    settings: getSettings(),
    providers,
    models,
    aliases,
  }
}

export function importBackup(data: BackupData): void {
  validateBackupGraph(data)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM providers').run()
    const insertProvider = db.prepare(
      `INSERT INTO providers (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, enabled, created_at, updated_at)
       VALUES (@id, @name, @protocol, @base_url, @auth_json, @custom_headers_json, @proxy_url, @timeout_ms, @model_filter, @enabled, @created_at, @updated_at)`,
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
        model_filter: p.model_filter ?? null,
        enabled: p.enabled,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })
    }
    const insertModel = db.prepare(
      `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertAlias = db.prepare(
      `INSERT INTO model_aliases (protocol, alias_name, provider_id, model_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const now = new Date().toISOString()
    for (const m of data.models) {
      insertModel.run(m.provider_id, m.model_id, m.display_name, m.enabled, m.source, now, now)
    }
    for (const a of data.aliases ?? []) {
      insertAlias.run(a.protocol, a.alias_name, a.provider_id, a.model_id, now, now)
    }
    setAdminToken(data.token)
    updateSettings(data.settings)
  })
  tx()
  invalidateAllDispatchers()
}
