import { db } from '../db'
import type { ProviderModelRow, ProviderRow, ProviderProtocol } from '../types'

export interface ModelWithProvider extends ProviderModelRow {
  provider_name: string
  protocol: 'openai' | 'anthropic'
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

export function listEnabledModels(protocol: 'openai' | 'anthropic'): ModelWithProvider[] {
  return db
    .prepare(
      `SELECT pm.*, p.name AS provider_name, p.protocol AS protocol, p.enabled AS provider_enabled
       FROM provider_models pm
       JOIN providers p ON p.id = pm.provider_id
       WHERE pm.enabled = 1 AND p.enabled = 1 AND p.protocol = ?
       ORDER BY pm.model_id ASC`,
    )
    .all(protocol) as ModelWithProvider[]
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
  db.prepare(
    `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
     VALUES (?, ?, ?, 0, 'manual', ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
  ).run(input.provider_id, input.model_id, input.display_name ?? null, now, now)
  return getModel(input.provider_id, input.model_id)!
}

/** 启用模型：事务内先禁用同协议下其他 Provider 的同名模型，再启用目标模型 */
export function setModelEnabled(input: {
  provider_id: string
  model_id: string
  enabled: number
}): ProviderModelRow {
  db.transaction(() => {
    if (input.enabled) {
      const protocol = (db.prepare('SELECT protocol FROM providers WHERE id = ?').get(input.provider_id) as
        | { protocol: string }
        | undefined)?.protocol
      if (protocol) {
        db.prepare(
          `UPDATE provider_models SET enabled = 0, updated_at = ?
           WHERE model_id = ? AND provider_id IN (SELECT id FROM providers WHERE protocol = ?)`,
        ).run(new Date().toISOString(), input.model_id, protocol)
      }
    }
    db.prepare('UPDATE provider_models SET enabled = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?').run(
      input.enabled,
      new Date().toISOString(),
      input.provider_id,
      input.model_id,
    )
  })()
  return getModel(input.provider_id, input.model_id)!
}

export function deleteModel(input: { provider_id: string; model_id: string }): void {
  db.prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?').run(
    input.provider_id,
    input.model_id,
  )
}

export type RouteResult =
  | { kind: 'ok'; provider: ProviderRow; model: ProviderModelRow }
  | { kind: 'not_found' }
  | { kind: 'provider_disabled' }

/** 按 (protocol, model_id) 查找启用的模型及其 Provider（单次 JOIN 查询） */
export function findRoute(protocol: 'openai' | 'anthropic', modelId: string): RouteResult {
  const row = db
    .prepare(
      `SELECT pm.*, p.id AS p_id, p.name AS p_name, p.protocol AS p_protocol, p.base_url AS p_base_url,
              p.auth_json AS p_auth_json, p.custom_headers_json AS p_custom_headers_json, p.proxy_url AS p_proxy_url,
              p.timeout_ms AS p_timeout_ms, p.model_filter AS p_model_filter, p.enabled AS p_enabled,
              p.created_at AS p_created_at, p.updated_at AS p_updated_at
       FROM provider_models pm
       JOIN providers p ON p.id = pm.provider_id
       WHERE pm.model_id = ? AND pm.enabled = 1 AND p.protocol = ?`,
    )
    .get(modelId, protocol) as (ProviderModelRow & Record<string, unknown>) | undefined
  if (row) {
    const provider: ProviderRow = {
      id: row.p_id as string,
      name: row.p_name as string,
      protocol: row.p_protocol as ProviderProtocol,
      base_url: row.p_base_url as string,
      auth_json: row.p_auth_json as string,
      custom_headers_json: row.p_custom_headers_json as string,
      proxy_url: row.p_proxy_url as string | null,
      timeout_ms: row.p_timeout_ms as number | null,
      model_filter: row.p_model_filter as string | null,
      enabled: row.p_enabled as number,
      created_at: row.p_created_at as string,
      updated_at: row.p_updated_at as string,
    }
    if (provider.enabled) {
      const model: ProviderModelRow = {
        provider_id: row.provider_id,
        model_id: row.model_id,
        display_name: row.display_name,
        enabled: row.enabled,
        source: row.source,
        fetched_at: row.fetched_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
      return { kind: 'ok', provider, model }
    }
    return { kind: 'provider_disabled' }
  }
  return { kind: 'not_found' }
}