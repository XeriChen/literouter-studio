import { db } from '../db'
import type { ModelAliasRow, ProviderModelRow, ProviderRow, ProviderProtocol } from '../types'

export interface ModelWithProvider extends ProviderModelRow {
  provider_name: string
  protocol: 'openai' | 'anthropic'
  provider_enabled: number
}

export interface AliasWithTarget extends ModelAliasRow {
  provider_name: string
  provider_protocol: 'openai' | 'anthropic'
  target_enabled: number
  provider_enabled: number
}

export function listModels(): ModelWithProvider[] {
  return db
    .prepare(
      `SELECT pm.*, p.name AS provider_name, p.protocol AS protocol, p.enabled AS provider_enabled
       FROM provider_models pm
       JOIN providers p ON p.id = pm.provider_id
       ORDER BY p.created_at ASC, pm.model_id ASC`,
    )
    .all() as ModelWithProvider[]
}

/** 代理 GET /v1/models 只暴露可用映射名（未建映射不可见；Provider 或目标模型禁用的也不可见、不可调用） */
export function listAliasNames(protocol: 'openai' | 'anthropic'): string[] {
  return (db
    .prepare(
      `SELECT a.alias_name
       FROM model_aliases a
       JOIN providers p ON p.id = a.provider_id
       JOIN provider_models pm ON pm.provider_id = a.provider_id AND pm.model_id = a.model_id
       WHERE a.protocol = ? AND p.enabled = 1 AND pm.enabled = 1
       ORDER BY a.alias_name ASC`,
    )
    .all(protocol) as { alias_name: string }[]).map((r) => r.alias_name)
}

export function getModel(providerId: string, modelId: string): ProviderModelRow | undefined {
  return db
    .prepare('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?')
    .get(providerId, modelId) as ProviderModelRow | undefined
}

export function addModel(input: {
  provider_id: string
  model_id: string
  display_name: string | null
}): ProviderModelRow {
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'manual', ?, ?)
       ON CONFLICT(provider_id, model_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
    ).run(input.provider_id, input.model_id, input.display_name ?? null, now, now)
    // 自动建立同名映射（已存在则不覆盖，保留用户自定义映射）
    const protocol = (db.prepare('SELECT protocol FROM providers WHERE id = ?').get(input.provider_id) as
      | { protocol: string }
      | undefined)?.protocol
    if (protocol) {
      db.prepare(
        `INSERT OR IGNORE INTO model_aliases (protocol, alias_name, provider_id, model_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(protocol, input.model_id, input.provider_id, input.model_id, now, now)
    }
  })()
  return getModel(input.provider_id, input.model_id)!
}

/** 启用/禁用模型（互斥机制已由映射层取代，直接切换） */
export function setModelEnabled(input: {
  provider_id: string
  model_id: string
  enabled: number
}): ProviderModelRow {
  db.prepare('UPDATE provider_models SET enabled = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?').run(
    input.enabled,
    new Date().toISOString(),
    input.provider_id,
    input.model_id,
  )
  return getModel(input.provider_id, input.model_id)!
}

export function deleteModel(input: { provider_id: string; model_id: string }): void {
  // 映射由外键 ON DELETE CASCADE 一并删除
  db.prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?').run(
    input.provider_id,
    input.model_id,
  )
}

// ---------- 模型映射（别名） ----------

export function listAliases(): AliasWithTarget[] {
  return db
    .prepare(
      `SELECT a.*, p.name AS provider_name, p.protocol AS provider_protocol, p.enabled AS provider_enabled,
              pm.enabled AS target_enabled
       FROM model_aliases a
       JOIN providers p ON p.id = a.provider_id
       JOIN provider_models pm ON pm.provider_id = a.provider_id AND pm.model_id = a.model_id
       ORDER BY a.protocol ASC, a.alias_name ASC`,
    )
    .all() as AliasWithTarget[]
}

export function getAlias(protocol: 'openai' | 'anthropic', aliasName: string): ModelAliasRow | undefined {
  return db
    .prepare('SELECT * FROM model_aliases WHERE protocol = ? AND alias_name = ?')
    .get(protocol, aliasName) as ModelAliasRow | undefined
}

export function addAlias(input: {
  protocol: 'openai' | 'anthropic'
  alias_name: string
  provider_id: string
  model_id: string
}): ModelAliasRow {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO model_aliases (protocol, alias_name, provider_id, model_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.protocol, input.alias_name, input.provider_id, input.model_id, now, now)
  return getAlias(input.protocol, input.alias_name)!
}

export function updateAlias(input: {
  protocol: 'openai' | 'anthropic'
  alias_name: string
  provider_id: string
  model_id: string
  new_alias_name?: string
}): ModelAliasRow {
  const targetName = input.new_alias_name ?? input.alias_name
  db.prepare(
    'UPDATE model_aliases SET provider_id = ?, model_id = ?, alias_name = ?, updated_at = ? WHERE protocol = ? AND alias_name = ?',
  ).run(input.provider_id, input.model_id, targetName, new Date().toISOString(), input.protocol, input.alias_name)
  return getAlias(input.protocol, targetName)!
}

export function deleteAlias(input: { protocol: 'openai' | 'anthropic'; alias_name: string }): void {
  db.prepare('DELETE FROM model_aliases WHERE protocol = ? AND alias_name = ?').run(input.protocol, input.alias_name)
}

export type RouteResult =
  | { kind: 'ok'; provider: ProviderRow; model: ProviderModelRow }
  | { kind: 'not_found' }
  | { kind: 'provider_disabled' }

interface RouteRow {
  model_provider_id: string
  model_id: string
  display_name: string | null
  model_enabled: number
  source: 'fetched' | 'manual'
  fetched_at: string | null
  model_created_at: string
  model_updated_at: string
  provider_id: string
  provider_name: string
  provider_protocol: ProviderProtocol
  base_url: string
  auth_json: string
  custom_headers_json: string
  proxy_url: string | null
  timeout_ms: number | null
  model_filter: string | null
  provider_enabled: number
  provider_created_at: string
  provider_updated_at: string
}

const findRouteStatement = db.prepare(
  `SELECT
     pm.provider_id AS model_provider_id,
     pm.model_id,
     pm.display_name,
     pm.enabled AS model_enabled,
     pm.source,
     pm.fetched_at,
     pm.created_at AS model_created_at,
     pm.updated_at AS model_updated_at,
     p.id AS provider_id,
     p.name AS provider_name,
     p.protocol AS provider_protocol,
     p.base_url,
     p.auth_json,
     p.custom_headers_json,
     p.proxy_url,
     p.timeout_ms,
     p.model_filter,
     p.enabled AS provider_enabled,
     p.created_at AS provider_created_at,
     p.updated_at AS provider_updated_at
   FROM model_aliases a
   JOIN provider_models pm ON pm.provider_id = a.provider_id AND pm.model_id = a.model_id
   JOIN providers p ON p.id = a.provider_id AND p.protocol = a.protocol
   WHERE a.protocol = ? AND a.alias_name = ?`,
)

/** 按 (protocol, alias) 查映射 -> 目标真实模型，校验目标已启用且 Provider 已启用 */
export function findRoute(protocol: 'openai' | 'anthropic', aliasName: string): RouteResult {
  const row = findRouteStatement.get(protocol, aliasName) as RouteRow | undefined
  if (!row) return { kind: 'not_found' }

  const provider: ProviderRow = {
    id: row.provider_id,
    name: row.provider_name,
    protocol: row.provider_protocol,
    base_url: row.base_url,
    auth_json: row.auth_json,
    custom_headers_json: row.custom_headers_json,
    proxy_url: row.proxy_url,
    timeout_ms: row.timeout_ms,
    model_filter: row.model_filter,
    enabled: row.provider_enabled,
    created_at: row.provider_created_at,
    updated_at: row.provider_updated_at,
  }
  const model: ProviderModelRow = {
    provider_id: row.model_provider_id,
    model_id: row.model_id,
    display_name: row.display_name,
    enabled: row.model_enabled,
    source: row.source,
    fetched_at: row.fetched_at,
    created_at: row.model_created_at,
    updated_at: row.model_updated_at,
  }
  if (!model.enabled) return { kind: 'not_found' }
  if (!provider.enabled) return { kind: 'provider_disabled' }
  return { kind: 'ok', provider, model }
}
