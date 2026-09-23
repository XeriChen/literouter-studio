import { db } from '../db'
import { decryptAuthJson } from '../providers/headers'
import type { ThinkingRewrite } from '../proxy/body'
import type {
  ModelAliasRow,
  ModelAliasTargetRow,
  ProviderModelRow,
  ProviderProtocol,
  ProviderRow,
} from '../types'
import { clearHealthState } from './health'
import { parseThinkingRewrite } from './thinking'

export type RouteResult =
  | { kind: 'ok'; alias: ModelAliasRow; thinking: ThinkingRewrite | null; candidates: RouteCandidate[] }
  | { kind: 'not_found' }
  | { kind: 'provider_disabled' }

export interface RouteCandidate {
  target: ModelAliasTargetRow
  provider: ProviderRow
  model: ProviderModelRow
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

/** 修复各映射的 active 候选：当前目标不可用时按 priority 切到第一个可用候选。 */
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
    // 切换 active 目标后清理该映射的健康状态
    clearHealthState(`${alias.protocol}/${alias.alias_name}`)
  }
}

/**
 * 代理 GET /v1/models 暴露「至少存在一个可用候选」的已启用映射。
 * weighted / failover 模式没有固定 active 目标，因此不按 active 过滤。
 */
export function listAliasNames(protocol: ProviderProtocol): string[] {
  return (db
    .prepare(
      `SELECT a.alias_name
       FROM model_aliases a
       WHERE a.protocol = ? AND a.enabled = 1 AND EXISTS (
         SELECT 1 FROM model_alias_targets t
         JOIN providers p ON p.id = t.provider_id
         JOIN provider_models pm ON pm.provider_id = t.provider_id AND pm.model_id = t.model_id
         WHERE t.protocol = a.protocol AND t.alias_name = a.alias_name AND p.enabled = 1 AND pm.enabled = 1
       )
       ORDER BY a.alias_name ASC`,
    )
    .all(protocol) as { alias_name: string }[]).map((r) => r.alias_name)
}

interface AliasRouteRow {
  alias_enabled: number
  thinking_json: string | null
  routing_config_json: string | null
  target_id: number
  target_priority: number
  target_active: number
  target_weight: number
  target_created_at: string
  target_updated_at: string
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
  auth_json_encrypted: string | null
  custom_headers_json: string
  proxy_url: string | null
  timeout_ms: number | null
  model_filter: string | null
  provider_enabled: number
  upstream_type: 'newapi' | 'sub2api' | null
  provider_created_at: string
  provider_updated_at: string
}

const findRouteRowsStatement = db.prepare(
  `SELECT
     a.enabled AS alias_enabled,
     a.thinking_json AS thinking_json,
     a.routing_config_json AS routing_config_json,
     t.id AS target_id,
     t.priority AS target_priority,
     t.active AS target_active,
     t.weight AS target_weight,
     t.created_at AS target_created_at,
     t.updated_at AS target_updated_at,
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
     p.auth_json_encrypted,
     p.custom_headers_json,
     p.proxy_url,
     p.timeout_ms,
     p.model_filter,
     p.enabled AS provider_enabled,
     p.upstream_type,
     p.created_at AS provider_created_at,
     p.updated_at AS provider_updated_at
   FROM model_aliases a
   JOIN model_alias_targets t
     ON t.protocol = a.protocol AND t.alias_name = a.alias_name
   JOIN provider_models pm ON pm.provider_id = t.provider_id AND pm.model_id = t.model_id
   JOIN providers p ON p.id = t.provider_id AND p.protocol = a.protocol
   WHERE a.protocol = ? AND a.alias_name = ?
     AND p.enabled = 1 AND pm.enabled = 1
   ORDER BY t.priority ASC, t.id ASC`,
)

function getAliasForRoute(protocol: ProviderProtocol, aliasName: string): ModelAliasRow | undefined {
  return db.prepare('SELECT * FROM model_aliases WHERE protocol = ? AND alias_name = ?').get(protocol, aliasName) as ModelAliasRow | undefined
}

/**
 * 代理路由解析：返回映射上全部可用候选（Provider 与模型均已启用），按 priority ASC, id ASC 排序。
 * 候选的使用顺序（single / weighted / failover）由 services/routing 的 buildCandidateOrder 决定。
 * - 映射不存在或未启用 → not_found
 * - 映射存在但没有任何可用候选 → provider_disabled
 */
export function findRoute(protocol: ProviderProtocol, aliasName: string): RouteResult {
  const rows = findRouteRowsStatement.all(protocol, aliasName) as AliasRouteRow[]
  const head = rows[0]
  if (!head || head.alias_enabled !== 1) {
    // 区分「映射不存在/禁用」与「存在但候选不可用」
    const alias = getAliasForRoute(protocol, aliasName)
    if (!alias || !alias.enabled) return { kind: 'not_found' }
    // 映射存在且启用，但没有可用候选：provider_disabled
    return { kind: 'provider_disabled' }
  }
  // SQL 已过滤 provider/model 均启用的候选，rows 非空说明有可用候选
  const alias: ModelAliasRow = {
    protocol,
    alias_name: aliasName,
    group_id: null,
    enabled: head.alias_enabled,
    thinking_json: head.thinking_json,
    routing_config_json: head.routing_config_json,
    created_at: '',
    updated_at: '',
  }
  const candidates: RouteCandidate[] = rows.map((row) => ({
    target: {
      id: row.target_id,
      protocol,
      alias_name: aliasName,
      provider_id: row.provider_id,
      model_id: row.model_id,
      priority: row.target_priority,
      active: row.target_active,
      weight: row.target_weight,
      created_at: row.target_created_at,
      updated_at: row.target_updated_at,
    },
    provider: {
      id: row.provider_id,
      name: row.provider_name,
      protocol: row.provider_protocol,
      group_id: row.provider_group_id,
      base_url: row.base_url,
      auth_json: decryptAuthJson(row),
      custom_headers_json: row.custom_headers_json,
      proxy_url: row.proxy_url,
      timeout_ms: row.timeout_ms,
      model_filter: row.model_filter,
      enabled: row.provider_enabled,
      upstream_type: row.upstream_type,
      created_at: row.provider_created_at,
      updated_at: row.provider_updated_at,
    },
    model: {
      provider_id: row.model_provider_id,
      model_id: row.model_id,
      display_name: row.display_name,
      enabled: row.model_enabled,
      source: row.source,
      fetched_at: row.fetched_at,
      created_at: row.model_created_at,
      updated_at: row.model_updated_at,
    },
  }))
  return { kind: 'ok', alias, thinking: parseThinkingRewrite(protocol, head.thinking_json), candidates }
}
