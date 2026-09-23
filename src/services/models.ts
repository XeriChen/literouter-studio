import { db } from '../db'
import type {
  ProviderModelRow,
  ProviderProtocol,
} from '../types'
import { insertAliasTargetInTransaction } from './aliases-crud'
import { repairAliasTargetsInTransaction } from './aliases-route'

// 向后兼容 barrel：历史调用方从 services/models 取映射/路由/thinking API
export * from './aliases-crud'
export * from './aliases-route'
export * from './thinking'

export interface ModelWithProvider extends ProviderModelRow {
  provider_name: string
  protocol: ProviderProtocol
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

export function getModel(providerId: string, modelId: string): ProviderModelRow | undefined {
  return db
    .prepare('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?')
    .get(providerId, modelId) as ProviderModelRow | undefined
}

function ensureAutoAliasTargetInTransaction(protocol: ProviderProtocol, modelId: string, providerId: string): void {
  const alias = db.prepare('SELECT 1 FROM model_aliases WHERE protocol = ? AND alias_name = ?').get(protocol, modelId)
  if (!alias) {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO model_aliases (protocol, alias_name, group_id, enabled, created_at, updated_at)
       VALUES (?, ?, NULL, 1, ?, ?)`,
    ).run(protocol, modelId, now, now)
    insertAliasTargetInTransaction({ protocol, alias_name: modelId, provider_id: providerId, model_id: modelId, active: 1, priority: 0 })
    return
  }
  // 已有映射只追加 inactive 候选，不改变当前目标。
  const target = db.prepare(
    `SELECT 1 FROM model_alias_targets WHERE protocol = ? AND alias_name = ? AND provider_id = ? AND model_id = ?`,
  ).get(protocol, modelId, providerId, modelId)
  if (!target) insertAliasTargetInTransaction({ protocol, alias_name: modelId, provider_id: providerId, model_id: modelId, active: 0 })
}

export function addModel(input: { provider_id: string; model_id: string; display_name: string | null }): ProviderModelRow {
  const now = new Date().toISOString()
  const provider = db.prepare('SELECT protocol, enabled FROM providers WHERE id = ?').get(input.provider_id) as { protocol: ProviderProtocol; enabled: number } | undefined
  db.transaction(() => {
    db.prepare(
      `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'manual', ?, ?)
       ON CONFLICT(provider_id, model_id) DO UPDATE SET display_name = excluded.display_name, enabled = 1, updated_at = excluded.updated_at`,
    ).run(input.provider_id, input.model_id, input.display_name ?? null, now, now)
    if (provider?.enabled === 1) ensureAutoAliasTargetInTransaction(provider.protocol, input.model_id, input.provider_id)
  })()
  return getModel(input.provider_id, input.model_id)!
}

export function setModelEnabled(input: { provider_id: string; model_id: string; enabled: number }): ProviderModelRow {
  db.transaction(() => {
    db.prepare('UPDATE provider_models SET enabled = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?').run(
      input.enabled, new Date().toISOString(), input.provider_id, input.model_id,
    )
    repairAliasTargetsInTransaction()
  })()
  return getModel(input.provider_id, input.model_id)!
}

export function deleteModel(input: { provider_id: string; model_id: string }): void {
  db.transaction(() => {
    db.prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?').run(input.provider_id, input.model_id)
    repairAliasTargetsInTransaction()
  })()
}

/** 一键清理 Provider 全部导入模型（source='fetched'）；手动添加的模型不受影响。同名映射与备份语义不变，仅候选目标随引用修复，可能留下无候选的无效映射。 */
export function cleanupImportedModels(providerId: string): number {
  return db.transaction(() => {
    const result = db.prepare("DELETE FROM provider_models WHERE provider_id = ? AND source = 'fetched'").run(providerId)
    repairAliasTargetsInTransaction()
    return Number(result.changes)
  })()
}

export function importModels(
  providerId: string,
  modelIds: string[],
  options: { createAlias?: boolean } = {},
): { added: number; updated: number } {
  const createAlias = options.createAlias !== false
  const now = new Date().toISOString()
  const provider = db.prepare('SELECT protocol, enabled FROM providers WHERE id = ?').get(providerId) as { protocol: ProviderProtocol; enabled: number } | undefined
  if (!provider) throw new Error('provider not found')
  const upsert = db.prepare(
    `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, fetched_at, created_at, updated_at)
     VALUES (?, ?, NULL, 1, 'fetched', ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET enabled = 1, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`,
  )
  return db.transaction((ids: string[]) => {
    let added = 0
    let updated = 0
    const existsStmt = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?')
    for (const id of ids) {
      const existed = existsStmt.get(providerId, id) !== undefined
      upsert.run(providerId, id, now, now, now)
      if (createAlias && provider.enabled === 1) ensureAutoAliasTargetInTransaction(provider.protocol, id, providerId)
      if (existed) updated++
      else added++
    }
    repairAliasTargetsInTransaction()
    return { added, updated }
  })([...new Set(modelIds)])
}
