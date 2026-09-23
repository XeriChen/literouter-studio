import { db } from '../db'
import { encrypt } from '../crypto'
import { decryptAuthJson, parseCustomHeaders } from '../providers/headers'
import { invalidateAllDispatchers } from '../proxy'
import { getAdminToken, setAdminToken } from './auth'
import { validateThinkingValue } from './models'
import { getSettings, updateSettings, type SettingsKey } from './settings'
import type { RoutingConfig } from './routing'
import type { ProviderRow, ThinkingConfig } from '../types'

export interface BackupTarget {
  provider_id: string
  model_id: string
  priority: number
  active: number
  weight: number
}

export interface BackupData {
  token: string
  settings: Partial<Record<SettingsKey, string>>
  providers: Array<{
    id: string
    name: string
    protocol: 'openai' | 'anthropic'
    group_id: string | null
    base_url: string
    auth: Record<string, string | { header_name: string; format: string }>
    custom_headers: Record<string, string>
    proxy_url: string | null
    timeout_ms: number | null
    model_filter: string | null
    upstream_type: 'newapi' | 'sub2api' | null
    enabled: number
    created_at: string
    updated_at: string
  }>
  provider_groups: Array<{
    protocol: 'openai' | 'anthropic'
    id: string
    name: string
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
    thinking: ThinkingConfig | null
    routing_config: RoutingConfig | null
    targets: BackupTarget[]
  }>
}


/** 与 aliases 写入路径 routingConfigSchema 同构：非法形状必须拒绝，不能静默钳制 */
function assertValidRoutingConfig(config: unknown, aliasLabel: string): asserts config is RoutingConfig | null {
  if (config === null || config === undefined) return
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`invalid alias routing_config: ${aliasLabel}`)
  }
  const c = config as Record<string, unknown>
  if (c.mode !== 'single' && c.mode !== 'weighted' && c.mode !== 'failover') {
    throw new Error(`invalid alias routing_config mode: ${aliasLabel}`)
  }
  const checkRange = (value: unknown, min: number, max: number, field: string): void => {
    if (value === undefined || value === null) return
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`invalid alias routing_config ${field}: ${aliasLabel}`)
    }
  }
  checkRange(c.affinity_seconds, 0, 3600, 'affinity_seconds')
  checkRange(c.max_attempts, 1, 10, 'max_attempts')
  checkRange(c.cooldown_seconds, 0, 3600, 'cooldown_seconds')
}

function validateBackupGraph(data: BackupData): void {
  const providerGroups = new Map<string, BackupData['provider_groups'][number]>()
  const providerGroupNames = new Set<string>()
  for (const group of data.provider_groups) {
    const key = JSON.stringify([group.protocol, group.id])
    if (providerGroups.has(key)) throw new Error(`duplicate provider group: ${group.protocol}/${group.id}`)
    const nameKey = JSON.stringify([group.protocol, group.name])
    if (providerGroupNames.has(nameKey)) throw new Error(`duplicate provider group name: ${group.protocol}/${group.name}`)
    providerGroups.set(key, group)
    providerGroupNames.add(nameKey)
  }

  const providers = new Map<string, BackupData['providers'][number]>()
  for (const provider of data.providers) {
    if (providers.has(provider.id)) throw new Error(`duplicate provider id: ${provider.id}`)
    if (provider.group_id && !providerGroups.has(JSON.stringify([provider.protocol, provider.group_id]))) {
      throw new Error(`provider group not found: ${provider.protocol}/${provider.group_id}`)
    }
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
    if (alias.thinking !== null && alias.thinking !== undefined) {
      if ((alias.thinking.mode !== 'override' && alias.thinking.mode !== 'default') || !validateThinkingValue(alias.protocol, alias.thinking.value)) {
        throw new Error(`invalid alias thinking config: ${alias.protocol}/${alias.alias_name}`)
      }
    }
    assertValidRoutingConfig(alias.routing_config, `${alias.protocol}/${alias.alias_name}`)
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
      const weight = target.weight ?? 100
      if (!Number.isInteger(weight) || weight < 0 || weight > 10000) throw new Error(`invalid alias target weight: ${alias.alias_name}`)
      if (target.active === 1) activeCount++
    }
    if (activeCount > 1) throw new Error(`multiple active alias targets: ${alias.protocol}/${alias.alias_name}`)
  }
}

function parseAuthJson(authJson: string): BackupData['providers'][number]['auth'] {
  try {
    const parsed = JSON.parse(authJson || '{}') as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as BackupData['providers'][number]['auth']
  } catch {
    return {}
  }
}

export function exportBackup(): BackupData {
  // 读原始行并用严格解密：解密失败必须让导出失败，绝不产出一份悄悄丢掉密钥的备份。
  // （listProviders 走的是「失败回退明文列」的宽松路径，明文列恒为空，导出会静默丢密钥。）
  const providerRows = db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all() as Array<ProviderRow & { auth_json_encrypted: string | null }>
  const providers = providerRows.map((p) => ({
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    group_id: p.group_id,
    base_url: p.base_url,
    auth: parseAuthJson(decryptAuthJson(p)),
    custom_headers: parseCustomHeaders(p),
    proxy_url: p.proxy_url,
    timeout_ms: p.timeout_ms,
    model_filter: p.model_filter,
    upstream_type: p.upstream_type,
    enabled: p.enabled,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }))
  const models = db.prepare('SELECT provider_id, model_id, display_name, enabled, source FROM provider_models').all() as BackupData['models']
  const provider_groups = db.prepare('SELECT protocol, id, name FROM provider_groups ORDER BY protocol, created_at, name').all() as BackupData['provider_groups']
  const groups = db.prepare('SELECT protocol, id, name FROM model_alias_groups ORDER BY protocol, created_at, name').all() as BackupData['groups']
  const aliases = db.prepare('SELECT protocol, alias_name, group_id, enabled, thinking_json, routing_config_json FROM model_aliases ORDER BY protocol, alias_name').all() as Array<{
    protocol: 'openai' | 'anthropic'
    alias_name: string
    group_id: string | null
    enabled: number
    thinking_json: string | null
    routing_config_json: string | null
  }>
  const targets = db.prepare('SELECT protocol, alias_name, provider_id, model_id, priority, active, weight FROM model_alias_targets ORDER BY protocol, alias_name, priority, id').all() as Array<BackupTarget & { protocol: 'openai' | 'anthropic'; alias_name: string; weight: number }>
  const byAlias = new Map<string, Array<BackupTarget & { weight: number }>>()
  for (const target of targets) {
    const key = `${target.protocol}/${target.alias_name}`
    const list = byAlias.get(key) ?? []
    list.push({ provider_id: target.provider_id, model_id: target.model_id, priority: target.priority, active: target.active, weight: target.weight })
    byAlias.set(key, list)
  }
  return {
    token: getAdminToken(),
    settings: getSettings(),
    providers,
    provider_groups,
    models,
    groups,
    aliases: aliases.map(({ thinking_json, routing_config_json, ...alias }) => ({
      ...alias,
      thinking: thinking_json ? JSON.parse(thinking_json) as ThinkingConfig : null,
      routing_config: routing_config_json ? JSON.parse(routing_config_json) as RoutingConfig : null,
      targets: byAlias.get(`${alias.protocol}/${alias.alias_name}`) ?? [],
    })),
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
    db.prepare('DELETE FROM provider_groups').run()
    const insertProviderGroup = db.prepare('INSERT INTO provider_groups (protocol, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    const insertProvider = db.prepare(
      `INSERT INTO providers (id, name, protocol, group_id, base_url, auth_json, auth_json_encrypted, custom_headers_json, proxy_url, timeout_ms, model_filter, upstream_type, enabled, created_at, updated_at)
       VALUES (@id, @name, @protocol, @group_id, @base_url, @auth_json, @auth_json_encrypted, @custom_headers_json, @proxy_url, @timeout_ms, @model_filter, @upstream_type, @enabled, @created_at, @updated_at)`,
    )
    const now = new Date().toISOString()
    for (const group of data.provider_groups) insertProviderGroup.run(group.protocol, group.id, group.name, now, now)
    for (const p of data.providers) {
      insertProvider.run({
        ...p,
        group_id: p.group_id ?? null,
        auth_json: '',
        auth_json_encrypted: encrypt(JSON.stringify(p.auth)),
        custom_headers_json: JSON.stringify(p.custom_headers),
        model_filter: p.model_filter ?? null,
        upstream_type: p.upstream_type ?? null,
      })
    }
    const insertModel = db.prepare(
      `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertGroup = db.prepare('INSERT INTO model_alias_groups (protocol, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    const insertAlias = db.prepare('INSERT INTO model_aliases (protocol, alias_name, group_id, enabled, thinking_json, routing_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insertTarget = db.prepare(
      `INSERT INTO model_alias_targets (protocol, alias_name, provider_id, model_id, priority, active, weight, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const m of data.models) insertModel.run(m.provider_id, m.model_id, m.display_name, m.enabled, m.source, now, now)
    for (const g of data.groups) insertGroup.run(g.protocol, g.id, g.name, now, now)
    for (const a of data.aliases) {
      insertAlias.run(a.protocol, a.alias_name, a.group_id, a.enabled, a.thinking ? JSON.stringify(a.thinking) : null, a.routing_config ? JSON.stringify(a.routing_config) : null, now, now)
      for (const target of a.targets) insertTarget.run(a.protocol, a.alias_name, target.provider_id, target.model_id, target.priority, target.active, target.weight ?? 100, now, now)
    }
    setAdminToken(data.token)
    updateSettings(data.settings)
  })
  tx()
  invalidateAllDispatchers()
}
