import { randomUUID } from 'node:crypto'
import { db } from '../db'
import type { ThinkingRewrite } from '../proxy/body'
import type {
  ModelAliasGroupRow,
  ModelAliasRow,
  ModelAliasTargetRow,
  ProviderModelRow,
  ProviderProtocol,
  ProviderRow,
  ThinkingConfig,
} from '../types'

export interface ModelWithProvider extends ProviderModelRow {
  provider_name: string
  protocol: ProviderProtocol
  provider_enabled: number
}

export interface AliasTargetWithMeta extends ModelAliasTargetRow {
  provider_name: string
  provider_protocol: ProviderProtocol
  target_enabled: number
  provider_enabled: number
}

export interface AliasWithTarget extends ModelAliasRow {
  group_name: string | null
  provider_id: string | null
  model_id: string | null
  provider_name: string | null
  provider_protocol: ProviderProtocol | null
  target_enabled: number
  provider_enabled: number
  targets: AliasTargetWithMeta[]
}

export interface AliasGroupWithStats extends ModelAliasGroupRow {
  alias_count: number
  enabled_count: number
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

/** 代理 GET /v1/models 只暴露已启用映射的 active 目标。 */
export function listAliasNames(protocol: ProviderProtocol): string[] {
  return (db
    .prepare(
      `SELECT a.alias_name
       FROM model_aliases a
       JOIN model_alias_targets t
         ON t.protocol = a.protocol AND t.alias_name = a.alias_name AND t.active = 1
       JOIN providers p ON p.id = t.provider_id
       JOIN provider_models pm ON pm.provider_id = t.provider_id AND pm.model_id = t.model_id
       WHERE a.protocol = ? AND a.enabled = 1 AND p.enabled = 1 AND pm.enabled = 1
       ORDER BY a.alias_name ASC`,
    )
    .all(protocol) as { alias_name: string }[]).map((r) => r.alias_name)
}

export function getModel(providerId: string, modelId: string): ProviderModelRow | undefined {
  return db
    .prepare('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?')
    .get(providerId, modelId) as ProviderModelRow | undefined
}

function targetAvailable(providerId: string, modelId: string): boolean {
  const row = db
    .prepare(
      `SELECT p.enabled AS provider_enabled, pm.enabled AS target_enabled
       FROM providers p JOIN provider_models pm ON pm.provider_id = p.id
       WHERE p.id = ? AND pm.model_id = ?`,
    )
    .get(providerId, modelId) as { provider_enabled: number; target_enabled: number } | undefined
  return !!row && row.provider_enabled === 1 && row.target_enabled === 1
}

function nextPriority(protocol: ProviderProtocol, aliasName: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(priority), -1) AS priority FROM model_alias_targets WHERE protocol = ? AND alias_name = ?')
    .get(protocol, aliasName) as { priority: number }
  return row.priority + 1
}

function normalizeTargetPriorities(protocol: ProviderProtocol, aliasName: string): void {
  const rows = db
    .prepare('SELECT id FROM model_alias_targets WHERE protocol = ? AND alias_name = ? ORDER BY priority ASC, id ASC')
    .all(protocol, aliasName) as { id: number }[]
  const update = db.prepare('UPDATE model_alias_targets SET priority = ?, updated_at = ? WHERE id = ?')
  const now = new Date().toISOString()
  rows.forEach((row, index) => update.run(index, now, row.id))
}

export function repairAliasTargetsInTransaction(): void {
  const aliases = db.prepare('SELECT protocol, alias_name FROM model_aliases').all() as Array<Pick<ModelAliasRow, 'protocol' | 'alias_name'>>
  const current = db.prepare(
    `SELECT provider_id, model_id FROM model_alias_targets
     WHERE protocol = ? AND alias_name = ? AND active = 1`,
  )
  const candidate = db.prepare(
    `SELECT t.id
     FROM model_alias_targets t
     JOIN providers p ON p.id = t.provider_id
     JOIN provider_models pm ON pm.provider_id = t.provider_id AND pm.model_id = t.model_id
     WHERE t.protocol = ? AND t.alias_name = ? AND p.enabled = 1 AND pm.enabled = 1
     ORDER BY t.priority ASC, t.id ASC LIMIT 1`,
  )
  const clear = db.prepare('UPDATE model_alias_targets SET active = 0, updated_at = ? WHERE protocol = ? AND alias_name = ?')
  const activate = db.prepare('UPDATE model_alias_targets SET active = 1, updated_at = ? WHERE id = ?')

  for (const alias of aliases) {
    const active = current.get(alias.protocol, alias.alias_name) as { provider_id: string; model_id: string } | undefined
    if (active && targetAvailable(active.provider_id, active.model_id)) continue
    const next = candidate.get(alias.protocol, alias.alias_name) as { id: number } | undefined
    if (!next) continue
    const now = new Date().toISOString()
    clear.run(now, alias.protocol, alias.alias_name)
    activate.run(now, next.id)
  }
}

function insertAliasTargetInTransaction(input: {
  protocol: ProviderProtocol
  alias_name: string
  provider_id: string
  model_id: string
  active: number
  priority?: number
}): ModelAliasTargetRow {
  const now = new Date().toISOString()
  const priority = input.priority ?? nextPriority(input.protocol, input.alias_name)
  if (input.active) {
    db.prepare('UPDATE model_alias_targets SET active = 0, updated_at = ? WHERE protocol = ? AND alias_name = ?').run(now, input.protocol, input.alias_name)
  }
  db.prepare(
    `INSERT INTO model_alias_targets
      (protocol, alias_name, provider_id, model_id, priority, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.protocol, input.alias_name, input.provider_id, input.model_id, priority, input.active, now, now)
  return db.prepare('SELECT * FROM model_alias_targets WHERE id = last_insert_rowid()').get() as ModelAliasTargetRow
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

export function importModels(providerId: string, modelIds: string[]): { added: number; updated: number } {
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
      if (provider.enabled === 1) ensureAutoAliasTargetInTransaction(provider.protocol, id, providerId)
      if (existed) updated++
      else added++
    }
    repairAliasTargetsInTransaction()
    return { added, updated }
  })([...new Set(modelIds)])
}

// ---------- 分组 ----------

export function listAliasGroups(): AliasGroupWithStats[] {
  return db.prepare(
    `SELECT g.*, COUNT(a.alias_name) AS alias_count,
            COALESCE(SUM(CASE WHEN a.enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled_count
     FROM model_alias_groups g
     LEFT JOIN model_aliases a ON a.protocol = g.protocol AND a.group_id = g.id
     GROUP BY g.protocol, g.id
     ORDER BY g.protocol ASC, g.created_at ASC, g.name ASC`,
  ).all() as AliasGroupWithStats[]
}

export function getAliasGroup(protocol: ProviderProtocol, id: string): ModelAliasGroupRow | undefined {
  return db.prepare('SELECT * FROM model_alias_groups WHERE protocol = ? AND id = ?').get(protocol, id) as ModelAliasGroupRow | undefined
}

export function createAliasGroup(input: { protocol: ProviderProtocol; name: string }): ModelAliasGroupRow {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO model_alias_groups (protocol, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(input.protocol, id, input.name, now, now)
  return getAliasGroup(input.protocol, id)!
}

export function updateAliasGroup(input: { protocol: ProviderProtocol; id: string; name: string }): ModelAliasGroupRow {
  db.prepare('UPDATE model_alias_groups SET name = ?, updated_at = ? WHERE protocol = ? AND id = ?').run(input.name, new Date().toISOString(), input.protocol, input.id)
  return getAliasGroup(input.protocol, input.id)!
}

export function deleteAliasGroup(input: { protocol: ProviderProtocol; id: string }): number {
  const count = (db.prepare('SELECT COUNT(*) AS count FROM model_aliases WHERE protocol = ? AND group_id = ?').get(input.protocol, input.id) as { count: number }).count
  db.prepare('DELETE FROM model_alias_groups WHERE protocol = ? AND id = ?').run(input.protocol, input.id)
  return count
}

export function enableGroupAliases(input: { protocol: ProviderProtocol; group_id: string }): number {
  const result = db.prepare('UPDATE model_aliases SET enabled = 1, updated_at = ? WHERE protocol = ? AND group_id = ?').run(new Date().toISOString(), input.protocol, input.group_id)
  return Number(result.changes)
}

export function deleteGroupAliases(input: { protocol: ProviderProtocol; group_id: string }): number {
  const result = db.prepare('DELETE FROM model_aliases WHERE protocol = ? AND group_id = ?').run(input.protocol, input.group_id)
  return Number(result.changes)
}

// ---------- 模型映射 ----------

export function listAliases(): AliasWithTarget[] {
  const aliases = db.prepare(
    `SELECT a.*, g.name AS group_name,
            t.provider_id AS active_provider_id, t.model_id AS active_model_id,
            p.name AS active_provider_name, p.protocol AS active_provider_protocol,
            p.enabled AS active_provider_enabled, pm.enabled AS active_target_enabled
     FROM model_aliases a
     LEFT JOIN model_alias_groups g ON g.protocol = a.protocol AND g.id = a.group_id
     LEFT JOIN model_alias_targets t ON t.protocol = a.protocol AND t.alias_name = a.alias_name AND t.active = 1
     LEFT JOIN providers p ON p.id = t.provider_id
     LEFT JOIN provider_models pm ON pm.provider_id = t.provider_id AND pm.model_id = t.model_id
     ORDER BY a.protocol ASC, COALESCE(g.created_at, '') ASC, a.alias_name ASC`,
  ).all() as Array<ModelAliasRow & {
    group_name: string | null
    active_provider_id: string | null
    active_model_id: string | null
    active_provider_name: string | null
    active_provider_protocol: ProviderProtocol | null
    active_provider_enabled: number | null
    active_target_enabled: number | null
  }>
  const targets = db.prepare(
    `SELECT t.*, p.name AS provider_name, p.protocol AS provider_protocol,
            p.enabled AS provider_enabled, pm.enabled AS target_enabled
     FROM model_alias_targets t
     JOIN providers p ON p.id = t.provider_id
     JOIN provider_models pm ON pm.provider_id = t.provider_id AND pm.model_id = t.model_id
     ORDER BY t.protocol ASC, t.alias_name ASC, t.priority ASC, t.id ASC`,
  ).all() as AliasTargetWithMeta[]
  const targetMap = new Map<string, AliasTargetWithMeta[]>()
  for (const target of targets) {
    const key = `${target.protocol}/${target.alias_name}`
    const list = targetMap.get(key) ?? []
    list.push(target)
    targetMap.set(key, list)
  }
  return aliases.map((row) => ({
    protocol: row.protocol,
    alias_name: row.alias_name,
    group_id: row.group_id,
    group_name: row.group_name,
    enabled: row.enabled,
    thinking_json: row.thinking_json,
    provider_id: row.active_provider_id,
    model_id: row.active_model_id,
    provider_name: row.active_provider_name,
    provider_protocol: row.active_provider_protocol,
    provider_enabled: row.active_provider_enabled ?? 0,
    target_enabled: row.active_target_enabled ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    targets: targetMap.get(`${row.protocol}/${row.alias_name}`) ?? [],
  }))
}

export function getAlias(protocol: ProviderProtocol, aliasName: string): ModelAliasRow | undefined {
  return db.prepare('SELECT * FROM model_aliases WHERE protocol = ? AND alias_name = ?').get(protocol, aliasName) as ModelAliasRow | undefined
}

export function addAlias(input: {
  protocol: ProviderProtocol
  alias_name: string
  provider_id: string
  model_id: string
  group_id?: string | null
  enabled?: number
  thinking?: ThinkingConfig | null
}): ModelAliasRow {
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO model_aliases (protocol, alias_name, group_id, enabled, thinking_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.protocol,
      input.alias_name,
      input.group_id ?? null,
      input.enabled ?? 1,
      input.thinking ? JSON.stringify(input.thinking) : null,
      now,
      now,
    )
    insertAliasTargetInTransaction({ protocol: input.protocol, alias_name: input.alias_name, provider_id: input.provider_id, model_id: input.model_id, active: 1, priority: 0 })
  })()
  return getAlias(input.protocol, input.alias_name)!
}

export function updateAlias(input: {
  protocol: ProviderProtocol
  alias_name: string
  new_alias_name?: string
  group_id?: string | null
  enabled?: number
  provider_id?: string
  model_id?: string
  /** undefined = 不变；null = 清除；对象 = 设置/更新 */
  thinking?: ThinkingConfig | null
}): ModelAliasRow {
  const targetName = input.new_alias_name ?? input.alias_name
  db.transaction(() => {
    const sets: string[] = ['alias_name = ?', 'updated_at = ?']
    const values: unknown[] = [targetName, new Date().toISOString()]
    if (input.group_id !== undefined) { sets.push('group_id = ?'); values.push(input.group_id) }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); values.push(input.enabled) }
    if (input.thinking !== undefined) { sets.push('thinking_json = ?'); values.push(input.thinking ? JSON.stringify(input.thinking) : null) }
    values.push(input.protocol, input.alias_name)
    db.prepare(`UPDATE model_aliases SET ${sets.join(', ')} WHERE protocol = ? AND alias_name = ?`).run(...values)

    if (input.provider_id !== undefined && input.model_id !== undefined) {
      const target = db.prepare(
        `SELECT 1 FROM model_alias_targets WHERE protocol = ? AND alias_name = ? AND provider_id = ? AND model_id = ?`,
      ).get(input.protocol, targetName, input.provider_id, input.model_id)
      if (!target) insertAliasTargetInTransaction({ protocol: input.protocol, alias_name: targetName, provider_id: input.provider_id, model_id: input.model_id, active: 0 })
      const now = new Date().toISOString()
      db.prepare('UPDATE model_alias_targets SET active = 0, updated_at = ? WHERE protocol = ? AND alias_name = ?').run(now, input.protocol, targetName)
      db.prepare(
        `UPDATE model_alias_targets SET active = 1, updated_at = ?
         WHERE protocol = ? AND alias_name = ? AND provider_id = ? AND model_id = ?`,
      ).run(now, input.protocol, targetName, input.provider_id, input.model_id)
    }
  })()
  return getAlias(input.protocol, targetName)!
}

export function deleteAlias(input: { protocol: ProviderProtocol; alias_name: string }): void {
  db.prepare('DELETE FROM model_aliases WHERE protocol = ? AND alias_name = ?').run(input.protocol, input.alias_name)
}

export function addAliasTarget(input: { protocol: ProviderProtocol; alias_name: string; provider_id: string; model_id: string }): ModelAliasTargetRow {
  return db.transaction(() => {
    const hasAny = db.prepare('SELECT 1 FROM model_alias_targets WHERE protocol = ? AND alias_name = ? LIMIT 1').get(input.protocol, input.alias_name)
    return insertAliasTargetInTransaction({ ...input, active: hasAny ? 0 : 1 })
  })()
}

export function getAliasTarget(input: { protocol: ProviderProtocol; alias_name: string; provider_id: string; model_id: string }): ModelAliasTargetRow | undefined {
  return db.prepare(
    `SELECT * FROM model_alias_targets WHERE protocol = ? AND alias_name = ? AND provider_id = ? AND model_id = ?`,
  ).get(input.protocol, input.alias_name, input.provider_id, input.model_id) as ModelAliasTargetRow | undefined
}

export function activateAliasTarget(input: { protocol: ProviderProtocol; alias_name: string; provider_id: string; model_id: string }): ModelAliasTargetRow {
  return db.transaction(() => {
    const target = db.prepare(
      `SELECT * FROM model_alias_targets WHERE protocol = ? AND alias_name = ? AND provider_id = ? AND model_id = ?`,
    ).get(input.protocol, input.alias_name, input.provider_id, input.model_id) as ModelAliasTargetRow | undefined
    if (!target) throw new Error('alias target not found')
    const now = new Date().toISOString()
    db.prepare('UPDATE model_alias_targets SET active = 0, updated_at = ? WHERE protocol = ? AND alias_name = ?').run(now, input.protocol, input.alias_name)
    db.prepare('UPDATE model_alias_targets SET active = 1, updated_at = ? WHERE id = ?').run(now, target.id)
    return db.prepare('SELECT * FROM model_alias_targets WHERE id = ?').get(target.id) as ModelAliasTargetRow
  })()
}

export function deleteAliasTarget(input: { protocol: ProviderProtocol; alias_name: string; provider_id: string; model_id: string }): void {
  db.transaction(() => {
    const target = db.prepare(
      `SELECT id, active FROM model_alias_targets WHERE protocol = ? AND alias_name = ? AND provider_id = ? AND model_id = ?`,
    ).get(input.protocol, input.alias_name, input.provider_id, input.model_id) as { id: number; active: number } | undefined
    if (!target) throw new Error('alias target not found')
    db.prepare('DELETE FROM model_alias_targets WHERE id = ?').run(target.id)
    normalizeTargetPriorities(input.protocol, input.alias_name)
    if (target.active) repairAliasTargetsInTransaction()
  })()
}

export function reorderAliasTargets(input: { protocol: ProviderProtocol; alias_name: string; targets: Array<{ provider_id: string; model_id: string }> }): void {
  db.transaction(() => {
    const existing = db.prepare(
      `SELECT provider_id, model_id FROM model_alias_targets WHERE protocol = ? AND alias_name = ?`,
    ).all(input.protocol, input.alias_name) as Array<{ provider_id: string; model_id: string }>
    const key = (target: { provider_id: string; model_id: string }) => `${target.provider_id}\u0000${target.model_id}`
    const expected = new Set(existing.map(key))
    const actual = input.targets.map(key)
    if (actual.length !== expected.size || new Set(actual).size !== actual.length || actual.some((value) => !expected.has(value))) throw new Error('invalid alias target order')
    const update = db.prepare(
      `UPDATE model_alias_targets SET priority = ?, updated_at = ?
       WHERE protocol = ? AND alias_name = ? AND provider_id = ? AND model_id = ?`,
    )
    const now = new Date().toISOString()
    input.targets.forEach((target, priority) => update.run(priority, now, input.protocol, input.alias_name, target.provider_id, target.model_id))
  })()
}

export type RouteResult =
  | { kind: 'ok'; provider: ProviderRow; model: ProviderModelRow; thinking: ThinkingRewrite | null }
  | { kind: 'not_found' }
  | { kind: 'provider_disabled' }

/** 解析映射上的思考等级配置为请求体改写指令；配置缺失或损坏时返回 null（按纯透传处理）。 */
export function parseThinkingRewrite(protocol: ProviderProtocol, thinkingJson: string | null): ThinkingRewrite | null {
  if (!thinkingJson) return null
  try {
    const config = JSON.parse(thinkingJson) as ThinkingConfig
    if (config.mode !== 'override' && config.mode !== 'default') return null
    return { key: protocol === 'anthropic' ? 'thinking' : 'reasoning_effort', mode: config.mode, value: config.value }
  } catch {
    return null
  }
}

/** 按协议校验思考配置的原生值：anthropic 为 thinking 对象，openai 为 reasoning_effort 字符串。 */
export function validateThinkingValue(protocol: ProviderProtocol, value: unknown): boolean {
  if (protocol === 'openai') return typeof value === 'string' && value.length > 0
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const thinking = value as Record<string, unknown>
  if (thinking.type === 'enabled') return Number.isInteger(thinking.budget_tokens) && (thinking.budget_tokens as number) >= 1024
  return thinking.type === 'disabled'
}

interface RouteRow {
  alias_enabled: number
  thinking_json: string | null
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
  provider_group_id: string | null
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
     a.enabled AS alias_enabled,
     a.thinking_json AS thinking_json,
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
     p.group_id AS provider_group_id,
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
   JOIN model_alias_targets t
     ON t.protocol = a.protocol AND t.alias_name = a.alias_name AND t.active = 1
   JOIN provider_models pm ON pm.provider_id = t.provider_id AND pm.model_id = t.model_id
   JOIN providers p ON p.id = t.provider_id AND p.protocol = a.protocol
   WHERE a.protocol = ? AND a.alias_name = ?`,
)

/** 按 (protocol, alias) 查 active 映射；请求期间不尝试其他候选。 */
export function findRoute(protocol: ProviderProtocol, aliasName: string): RouteResult {
  const row = findRouteStatement.get(protocol, aliasName) as RouteRow | undefined
  if (!row || !row.alias_enabled || !row.model_enabled) return { kind: 'not_found' }
  const provider: ProviderRow = {
    id: row.provider_id,
    name: row.provider_name,
    protocol: row.provider_protocol,
    group_id: row.provider_group_id,
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
  if (!provider.enabled) return { kind: 'provider_disabled' }
  return { kind: 'ok', provider, model, thinking: parseThinkingRewrite(protocol, row.thinking_json) }
}
