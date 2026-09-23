import { randomUUID } from 'node:crypto'
import { db } from '../db'
import type {
  ModelAliasGroupRow,
  ModelAliasRow,
  ModelAliasTargetRow,
  ProviderProtocol,
  ThinkingConfig,
} from '../types'
import { clearHealthState } from './health'
import { repairAliasTargetsInTransaction } from './aliases-route'
import { type RoutingConfig } from './routing'

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

/** 插入候选目标；active=1 时先清掉同映射其余 active 并清理健康状态。 */
export function insertAliasTargetInTransaction(input: {
  protocol: ProviderProtocol
  alias_name: string
  provider_id: string
  model_id: string
  active: number
  priority?: number
  weight?: number
}): ModelAliasTargetRow {
  const now = new Date().toISOString()
  const priority = input.priority ?? nextPriority(input.protocol, input.alias_name)
  const weight = input.weight ?? 100
  if (input.active) {
    db.prepare('UPDATE model_alias_targets SET active = 0, updated_at = ? WHERE protocol = ? AND alias_name = ?').run(now, input.protocol, input.alias_name)
    clearHealthState(`${input.protocol}/${input.alias_name}`)
  }
  db.prepare(
    `INSERT INTO model_alias_targets
      (protocol, alias_name, provider_id, model_id, priority, active, weight, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.protocol, input.alias_name, input.provider_id, input.model_id, priority, input.active, weight, now, now)
  return db.prepare('SELECT * FROM model_alias_targets WHERE id = last_insert_rowid()').get() as ModelAliasTargetRow
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
  // 先查询该分组的所有映射名，用于清理健康状态
  const aliases = db.prepare('SELECT alias_name FROM model_aliases WHERE protocol = ? AND group_id = ?')
    .all(input.protocol, input.id) as { alias_name: string }[]

  const count = (db.prepare('SELECT COUNT(*) AS count FROM model_aliases WHERE protocol = ? AND group_id = ?').get(input.protocol, input.id) as { count: number }).count
  db.prepare('DELETE FROM model_alias_groups WHERE protocol = ? AND id = ?').run(input.protocol, input.id)

  // 删除分组后，级联删除的映射需要清理健康状态
  for (const { alias_name } of aliases) {
    clearHealthState(`${input.protocol}/${alias_name}`)
  }

  return count
}

export function enableGroupAliases(input: { protocol: ProviderProtocol; group_id: string }): number {
  const result = db.prepare('UPDATE model_aliases SET enabled = 1, updated_at = ? WHERE protocol = ? AND group_id = ?').run(new Date().toISOString(), input.protocol, input.group_id)
  return Number(result.changes)
}

export function deleteGroupAliases(input: { protocol: ProviderProtocol; group_id: string }): number {
  // 先查询该分组的所有映射名，用于清理健康状态
  const aliases = db.prepare('SELECT alias_name FROM model_aliases WHERE protocol = ? AND group_id = ?')
    .all(input.protocol, input.group_id) as { alias_name: string }[]

  const result = db.prepare('DELETE FROM model_aliases WHERE protocol = ? AND group_id = ?').run(input.protocol, input.group_id)

  // 删除成功后清理健康状态
  for (const { alias_name } of aliases) {
    clearHealthState(`${input.protocol}/${alias_name}`)
  }

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
    routing_config_json: row.routing_config_json,
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
  /** 省略 = 创建无候选的空映射，之后通过候选接口补目标 */
  provider_id?: string
  model_id?: string
  group_id?: string | null
  enabled?: number
  thinking?: ThinkingConfig | null
  routing_config?: RoutingConfig | null
}): ModelAliasRow {
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO model_aliases (protocol, alias_name, group_id, enabled, thinking_json, routing_config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.protocol,
      input.alias_name,
      input.group_id ?? null,
      input.enabled ?? 1,
      input.thinking ? JSON.stringify(input.thinking) : null,
      input.routing_config ? JSON.stringify(input.routing_config) : null,
      now,
      now,
    )
    if (input.provider_id && input.model_id) {
      insertAliasTargetInTransaction({ protocol: input.protocol, alias_name: input.alias_name, provider_id: input.provider_id, model_id: input.model_id, active: 1, priority: 0 })
    }
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
  /** undefined = 不变；null = 清除；对象 = 设置/更新 */
  routing_config?: RoutingConfig | null
}): ModelAliasRow {
  const targetName = input.new_alias_name ?? input.alias_name
  db.transaction(() => {
    const sets: string[] = ['alias_name = ?', 'updated_at = ?']
    const values: unknown[] = [targetName, new Date().toISOString()]
    if (input.group_id !== undefined) { sets.push('group_id = ?'); values.push(input.group_id) }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); values.push(input.enabled) }
    if (input.thinking !== undefined) { sets.push('thinking_json = ?'); values.push(input.thinking ? JSON.stringify(input.thinking) : null) }
    if (input.routing_config !== undefined) { sets.push('routing_config_json = ?'); values.push(input.routing_config ? JSON.stringify(input.routing_config) : null) }
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
      clearHealthState(`${input.protocol}/${targetName}`)
    }
  })()
  return getAlias(input.protocol, targetName)!
}

export function deleteAlias(input: { protocol: ProviderProtocol; alias_name: string }): void {
  db.prepare('DELETE FROM model_aliases WHERE protocol = ? AND alias_name = ?').run(input.protocol, input.alias_name)
  clearHealthState(`${input.protocol}/${input.alias_name}`)
}

export interface MergeAliasesInput {
  protocol: ProviderProtocol
  /** 源映射名，按合并顺序；与目标同名的项会被忽略 */
  sources: string[]
  target_alias_name: string
  /** 仅当目标映射不存在（新建）时生效；null/缺省 = 未分组 */
  group_id?: string | null
  delete_sources?: boolean
}

export interface MergeAliasesResult {
  alias: ModelAliasRow
  created: boolean
  /** 实际参与合并的源映射名（已去重、已排除目标） */
  sources: string[]
  added: number
  skipped: number
  deleted: number
}

/**
 * 合并多个映射的候选目标到同一个映射名。
 * - 目标不存在则新建（enabled=1，thinking 继承 sources 顺序上第一个非空配置）
 * - 按 (provider_id, model_id) 去重，已存在则跳过
 * - 仅新建映射时以第一个源的当前目标作为 active；并入已有映射不改其 active
 */
export function mergeAliases(input: MergeAliasesInput): MergeAliasesResult {
  const sources = [...new Set(input.sources)].filter((name) => name !== input.target_alias_name)
  if (!sources.length) throw new Error('no source aliases to merge')
  const sourceRows = sources.map((name) => {
    const row = getAlias(input.protocol, name)
    if (!row) throw new Error('alias not found')
    return row
  })

  return db.transaction(() => {
    const created = !getAlias(input.protocol, input.target_alias_name)

    if (created) {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO model_aliases (protocol, alias_name, group_id, enabled, thinking_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        input.protocol,
        input.target_alias_name,
        input.group_id ?? null,
        sourceRows.map((row) => row.thinking_json).find((value) => value !== null) ?? null,
        now,
        now,
      )
    }

    const selectTargets = db.prepare(
      `SELECT * FROM model_alias_targets WHERE protocol = ? AND alias_name = ? ORDER BY priority ASC, id ASC`,
    )
    const existsTarget = db.prepare(
      `SELECT 1 FROM model_alias_targets WHERE protocol = ? AND alias_name = ? AND provider_id = ? AND model_id = ?`,
    )

    const firstTargets = selectTargets.all(input.protocol, sourceRows[0]?.alias_name ?? '') as ModelAliasTargetRow[]
    const designated = firstTargets.find((row) => row.active === 1) ?? firstTargets[0] ?? null

    let priority = nextPriority(input.protocol, input.target_alias_name)
    let added = 0
    let skipped = 0

    for (const source of sources) {
      const rows = selectTargets.all(input.protocol, source) as ModelAliasTargetRow[]
      for (const row of rows) {
        if (existsTarget.get(input.protocol, input.target_alias_name, row.provider_id, row.model_id)) {
          skipped++
          continue
        }
        insertAliasTargetInTransaction({
          protocol: input.protocol,
          alias_name: input.target_alias_name,
          provider_id: row.provider_id,
          model_id: row.model_id,
          active: created && designated !== null && row.id === designated.id ? 1 : 0,
          priority,
        })
        priority++
        added++
      }
    }

    let deleted = 0
    if (input.delete_sources) {
      const remove = db.prepare('DELETE FROM model_aliases WHERE protocol = ? AND alias_name = ?')
      for (const source of sources) {
        deleted += Number(remove.run(input.protocol, source).changes)
        // 删除源映射后清理其健康状态
        clearHealthState(`${input.protocol}/${source}`)
      }
    }

    repairAliasTargetsInTransaction()

    return {
      alias: getAlias(input.protocol, input.target_alias_name)!,
      created,
      sources,
      added,
      skipped,
      deleted,
    }
  })()
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

/** 设置候选的分配权重（weighted 模式消费）；0 表示仅作末位备选，不参与常规分配。 */
export function setAliasTargetWeight(input: { protocol: ProviderProtocol; alias_name: string; provider_id: string; model_id: string; weight: number }): ModelAliasTargetRow {
  const target = getAliasTarget(input)
  if (!target) throw new Error('alias target not found')
  db.prepare('UPDATE model_alias_targets SET weight = ?, updated_at = ? WHERE id = ?').run(
    input.weight,
    new Date().toISOString(),
    target.id,
  )
  return getAliasTarget(input)!
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
    clearHealthState(`${input.protocol}/${input.alias_name}`)
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
