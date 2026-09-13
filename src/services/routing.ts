import type { ModelAliasRow, ModelAliasTargetRow } from '../types'

export interface RoutingConfig {
  mode: 'single' | 'weighted' | 'failover'
  affinity_seconds?: number
  max_attempts?: number
  cooldown_seconds?: number
}

export const ROUTING_LIMITS = {
  max_attempts: { min: 1, max: 10 },
  cooldown_seconds: { min: 0, max: 3600 },
  affinity_seconds: { min: 0, max: 3600 },
} as const

function clampInt(value: unknown, limits: { min: number; max: number }): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return undefined
  return Math.min(limits.max, Math.max(limits.min, n))
}

/** 解析并钳制路由配置；JSON 缺失/损坏时回落 single，非法字段取默认值。
 * max_attempts/cooldown_seconds/affinity_seconds 为 undefined 表示「未配置」，语义见消费方：
 * max_attempts 未配置 = 尝试全部候选；cooldown_seconds 未配置 = 默认 60s；affinity_seconds 未配置 = 关闭。 */
export function parseRoutingConfig(json: string | null): RoutingConfig {
  if (!json) return { mode: 'single' }
  try {
    const parsed = JSON.parse(json) as Partial<RoutingConfig>
    const mode = parsed.mode === 'weighted' || parsed.mode === 'failover' ? parsed.mode : 'single'
    return {
      mode,
      affinity_seconds: clampInt(parsed.affinity_seconds, ROUTING_LIMITS.affinity_seconds),
      max_attempts: clampInt(parsed.max_attempts, ROUTING_LIMITS.max_attempts),
      cooldown_seconds: clampInt(parsed.cooldown_seconds, ROUTING_LIMITS.cooldown_seconds),
    }
  } catch {
    return { mode: 'single' }
  }
}

/** 供 API 层校验入参：非法字段以 undefined 表示，由调用方决定报错或忽略 */
export function normalizeRoutingConfigInput(input: Partial<RoutingConfig>): RoutingConfig | null {
  if (input.mode !== 'single' && input.mode !== 'weighted' && input.mode !== 'failover') return null
  return {
    mode: input.mode,
    affinity_seconds: clampInt(input.affinity_seconds, ROUTING_LIMITS.affinity_seconds),
    max_attempts: clampInt(input.max_attempts, ROUTING_LIMITS.max_attempts),
    cooldown_seconds: clampInt(input.cooldown_seconds, ROUTING_LIMITS.cooldown_seconds),
  }
}

/**
 * 生成候选目标尝试顺序（供代理重试循环消费）：
 * - single: 仅 active 目标（保持既有语义，无多候选重试）
 * - weighted: 全候选按 weight 加权随机排序（weight 0 者垫底；全 0 时均匀随机）——
 *   注意与 new-api「重试→优先级分层」不同：本项目的 weight 是纯分配权重，priority 只服务于 failover
 * - failover: priority ASC, id ASC 严格序
 */
export function buildCandidateOrder(
  alias: Pick<ModelAliasRow, 'routing_config_json'>,
  targets: ModelAliasTargetRow[],
): ModelAliasTargetRow[] {
  if (targets.length === 0) return []

  const config = parseRoutingConfig(alias.routing_config_json)

  switch (config.mode) {
    case 'weighted': {
      return weightedOrder(targets)
    }
    case 'failover': {
      return [...targets].sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id - b.id))
    }
    case 'single':
    default: {
      const active = targets.find((t) => t.active === 1)
      return active ? [active] : []
    }
  }
}

/** 加权随机全序：每次独立抽取一个未选目标；weight 0 最后（全 0 则均匀随机，对齐 new-api 平滑语义）。 */
function weightedOrder(targets: ModelAliasTargetRow[]): ModelAliasTargetRow[] {
  const pool = [...targets]
  const zeroWeight = pool.filter((t) => t.weight <= 0)
  const positives = pool.filter((t) => t.weight > 0)
  const ordered: ModelAliasTargetRow[] = []
  while (positives.length > 0) {
    const total = positives.reduce((sum, t) => sum + t.weight, 0)
    let random = Math.random() * total
    let index = positives.length - 1
    for (let i = 0; i < positives.length; i++) {
      random -= positives[i]!.weight
      if (random <= 0) { index = i; break }
    }
    ordered.push(positives.splice(index, 1)[0]!)
  }
  if (ordered.length === 0) {
    // 全零权重：均匀随机排序
    for (let i = zeroWeight.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = zeroWeight[i]!
      zeroWeight[i] = zeroWeight[j]!
      zeroWeight[j] = tmp
    }
    return zeroWeight
  }
  return [...ordered, ...zeroWeight.sort((a, b) => a.id - b.id)]
}

/**
 * 兼容保留：单次选择（管理面/测试用）。代理路径请使用 buildCandidateOrder。
 */
export function selectTarget(
  alias: ModelAliasRow,
  targets: ModelAliasTargetRow[],
): ModelAliasTargetRow | null {
  return buildCandidateOrder(alias, targets)[0] ?? null
}
