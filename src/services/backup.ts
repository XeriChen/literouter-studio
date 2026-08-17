import { db } from '../db'
import { parseAuth, parseCustomHeaders } from '../providers/headers'
import { invalidateAllDispatchers } from '../proxy'
import { getAdminToken, setAdminToken } from './auth'
import { getSettings, updateSettings, type SettingsKey } from './settings'
import type { ProviderRow } from '../types'

export interface BackupTarget {
  provider_id: string
  model_id: string
  priority: number
  active: number
}

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
  groups: Array<{
    protocol: 'openai' | 'anthropic'
    id: string
    name: string
  }>
  aliases: Array<{
    protocol: 'openai' | 'anthropic'
    alias_name: string
    group_id: string | null
    enabled: number
    targets: BackupTarget[]
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
    if (providerModels.has(model.model_id)) throw new Error(`duplicate model: ${model.provider_id}/${model.model_id}`)
    providerModels.add(model.model_id)
    models.set(model.provider_id, providerModels)
  }

  const groups = new Map<string, BackupData['groups'][number]>()
  const groupNames = new Set<string>()
  for (const group of data.groups) {
    const key = JSON.stringify([group.protocol, group.id])
    if (groups.has(key)) throw new Error(`duplicate alias group: ${group.protocol}/${group.id}`)
    const nameKey = JSON.stringify([group.protocol, group.name])
    if (groupNames.has(nameKey)) throw new Error(`duplicate alias group name: ${group.protocol}/${group.name}`)
    groups.set(key, group)
    groupNames.add(nameKey)
  }

  const aliases = new Set<string>()
  for (const alias of data.aliases) {
    const aliasKey = JSON.stringify([alias.protocol, alias.alias_name])
    if (aliases.has(aliasKey)) throw new Error(`duplicate alias: ${alias.protocol}/${alias.alias_name}`)
    aliases.add(aliasKey)
    if (alias.group_id && !groups.has(JSON.stringify([alias.protocol, alias.group_id]))) {
      throw new Error(`alias group not found: ${alias.protocol}/${alias.group_id}`)
    }
    const targets = new Set<string>()
    let activeCount = 0
    for (const target of alias.targets) {
      const targetKey = JSON.stringify([target.provider_id, target.model_id])
      if (targets.has(targetKey)) throw new Error(`duplicate alias target: ${alias.protocol}/${alias.alias_name}`)
      targets.add(targetKey)
      const provider = providers.get(target.provider_id)
      if (!provider) throw new Error(`alias target provider not found: ${target.provider_id}`)
      if (provider.protocol !== alias.protocol) throw new Error(`alias protocol mismatch: ${alias.protocol}/${alias.alias_name}`)
      if (!models.get(target.provider_id)?.has(target.model_id)) throw new Error(`alias target model not found: ${target.provider_id}/${target.model_id}`)
      if (!Number.isInteger(target.priority) || target.priority < 0) throw new Error(`invalid alias target priority: ${alias.alias_name}`)
      if (target.active === 1) activeCount++
    }
    if (activeCount > 1) throw new Error(`multiple active alias targets: ${alias.protocol}/${alias.alias_name}`)
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
  const models = db.prepare('SELECT provider_id, model_id, display_name, enabled, source FROM provider_models').all() as BackupData['models']
  const groups = db.prepare('SELECT protocol, id, name FROM model_alias_groups ORDER BY protocol, created_at, name').all() as BackupData['groups']
  const aliases = db.prepare('SELECT protocol, alias_name, group_id, enabled FROM model_aliases ORDER BY protocol, alias_name').all() as Array<{
    protocol: 'openai' | 'anthropic'
    alias_name: string
    group_id: string | null
    enabled: number
  }>
  const targets = db.prepare('SELECT protocol, alias_name, provider_id, model_id, priority, active FROM model_alias_targets ORDER BY protocol, alias_name, priority, id').all() as Array<BackupTarget & { protocol: 'openai' | 'anthropic'; alias_name: string }>
  const byAlias = new Map<string, BackupTarget[]>()
  for (const target of targets) {
    const key = `${target.protocol}/${target.alias_name}`
    const list = byAlias.get(key) ?? []
    list.push({ provider_id: target.provider_id, model_id: target.model_id, priority: target.priority, active: target.active })
    byAlias.set(key, list)
  }
  return {
    token: getAdminToken(),
    settings: getSettings(),
    providers,
    models,
    groups,
    aliases: aliases.map((alias) => ({ ...alias, targets: byAlias.get(`${alias.protocol}/${alias.alias_name}`) ?? [] })),
  }
}

export function importBackup(data: BackupData): void {
  validateBackupGraph(data)
  const tx = db.transaction(() => {
    // model_aliases can exist without a group, so deleting groups alone would
    // leave ungrouped aliases behind and make a full backup restore incomplete.
    db.prepare('DELETE FROM model_aliases').run()
    db.prepare('DELETE FROM model_alias_groups').run()
    db.prepare('DELETE FROM providers').run()
    const insertProvider = db.prepare(
      `INSERT INTO providers (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, enabled, created_at, updated_at)
       VALUES (@id, @name, @protocol, @base_url, @auth_json, @custom_headers_json, @proxy_url, @timeout_ms, @model_filter, @enabled, @created_at, @updated_at)`,
    )
    for (const p of data.providers) {
      insertProvider.run({ ...p, auth_json: JSON.stringify(p.auth), custom_headers_json: JSON.stringify(p.custom_headers), model_filter: p.model_filter ?? null })
    }
    const insertModel = db.prepare(
      `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertGroup = db.prepare('INSERT INTO model_alias_groups (protocol, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    const insertAlias = db.prepare('INSERT INTO model_aliases (protocol, alias_name, group_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    const insertTarget = db.prepare(
      `INSERT INTO model_alias_targets (protocol, alias_name, provider_id, model_id, priority, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = new Date().toISOString()
    for (const m of data.models) insertModel.run(m.provider_id, m.model_id, m.display_name, m.enabled, m.source, now, now)
    for (const g of data.groups) insertGroup.run(g.protocol, g.id, g.name, now, now)
    for (const a of data.aliases) {
      insertAlias.run(a.protocol, a.alias_name, a.group_id, a.enabled, now, now)
      for (const target of a.targets) insertTarget.run(a.protocol, a.alias_name, target.provider_id, target.model_id, target.priority, target.active, now, now)
    }
    setAdminToken(data.token)
    updateSettings(data.settings)
  })
  tx()
  invalidateAllDispatchers()
}
