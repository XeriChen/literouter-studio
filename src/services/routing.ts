import type { ModelAliasRow, ModelAliasTargetRow } from '../types'

export interface RoutingConfig {
  mode: 'single' | 'weighted' | 'failover'
  affinity_seconds?: number
  max_attempts?: number
  cooldown_seconds?: number
}

export function parseRoutingConfig(json: string | null): RoutingConfig {
  if (!json) return { mode: 'single' }
  try {
    const parsed = JSON.parse(json) as Partial<RoutingConfig>
    return {
      mode: parsed.mode || 'single',
      affinity_seconds: parsed.affinity_seconds,
      max_attempts: parsed.max_attempts,
      cooldown_seconds: parsed.cooldown_seconds,
    }
  } catch {
    return { mode: 'single' }
  }
}

/**
 * 按路由配置从候选目标中选择一个。
 * - single: 只返回 active=1 的目标（当前行为）
 * - weighted: 按 weight 字段加权随机选择
 * - failover: 按 priority 升序选择第一个（故障转移由外部失败计数触发）
 */
export function selectTarget(
  alias: ModelAliasRow,
  targets: ModelAliasTargetRow[],
  _sessionId?: string,
): ModelAliasTargetRow | null {
  if (targets.length === 0) return null

  const config = parseRoutingConfig(alias.routing_config_json)

  switch (config.mode) {
    case 'single': {
      const active = targets.find((t) => t.active === 1)
      return active ?? null
    }

    case 'weighted': {
      const totalWeight = targets.reduce((sum, t) => sum + t.weight, 0)
      if (totalWeight === 0) return targets[0] ?? null

      let random = Math.random() * totalWeight
      for (const target of targets) {
        random -= target.weight
        if (random <= 0) return target
      }
      return targets[targets.length - 1] ?? null
    }

    case 'failover': {
      const sorted = [...targets].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority
        return a.id - b.id
      })
      return sorted[0] ?? null
    }

    default:
      return targets.find((t) => t.active === 1) ?? null
  }
}
