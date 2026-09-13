/**
 * 进程内路由健康状态机（借鉴 octopus 的 RouteState 设计，无外部依赖）：
 * - 冷却：候选连续失败达阈值后，在 cooldown_seconds 内被选路跳过
 * - 单探测：全部候选都在冷却时，仅放行一个请求到最早到期的候选做探测；
 *   其余请求快速失败，避免全部涌向未恢复候选
 * - 亲和：探测/故障切换成功后，affinity_seconds 内后续请求固定使用该候选，
 *   给恢复中的上游一个确认窗口（仅在配置了 affinity_seconds 时生效）
 *
 * 状态只存内存，重启即清空；同一候选的失败计数跨请求累计，成功即清零。
 */

import type { RoutingConfig } from './routing'

export interface HealthPick<T> {
  target: T
  /** true = 本次是探测请求（独占），成功/失败/取消都必须回传对应 report */
  isProbe: boolean
}

export const DEFAULT_COOLDOWN_SECONDS = 60
/** 探测保留的最长独占时间：覆盖慢上游的响应窗口，超时自动释放探测位 */
const PROBE_TTL_MS = 120_000

interface AliasState {
  cooldowns: Map<number, number>
  failures: Map<number, number>
  probe: { targetId: number; expiresAt: number } | null
  affinity: { targetId: number; until: number } | null
}

const states = new Map<string, AliasState>()

function stateFor(key: string): AliasState {
  let state = states.get(key)
  if (!state) {
    state = { cooldowns: new Map(), failures: new Map(), probe: null, affinity: null }
    states.set(key, state)
  }
  return state
}

function cooldownMs(config: RoutingConfig): number {
  return (config.cooldown_seconds ?? DEFAULT_COOLDOWN_SECONDS) * 1000
}

/** 冷却失败阈值固定为 1：单次失败即进入冷却。
 * 不复用 max_attempts（它表示请求尝试上限），避免语义混淆。 */
function failureThreshold(_config: RoutingConfig): number {
  return 1
}

/**
 * 从已排序的候选中选出一个可尝试的目标。
 * 返回 null 表示当前没有可用目标（探测位被其他请求占用）。
 */
export function pickCandidate<T extends { id: number }>(
  aliasKey: string,
  ordered: T[],
  config: RoutingConfig,
  now: number = Date.now(),
): HealthPick<T> | null {
  if (ordered.length === 0) return null
  const state = stateFor(aliasKey)

  // 亲和期内直接固定亲和目标
  if (state.affinity) {
    if (state.affinity.until > now) {
      const target = ordered.find((t) => t.id === state.affinity!.targetId)
      if (target) return { target, isProbe: false }
    }
    state.affinity = null
  }

  // 找未冷却的可用目标
  const available = ordered.find((t) => {
    const until = state.cooldowns.get(t.id)
    return until === undefined || until <= now
  })
  if (available && !state.cooldowns.has(available.id)) {
    // 完全未冷却：正常返回
    return { target: available, isProbe: false }
  }

  // 全部冷却中：找最早到期候选
  let earliest: { id: number; until: number } | null = null
  for (const t of ordered) {
    const until = state.cooldowns.get(t.id)
    if (until !== undefined && (earliest === null || until < earliest.until)) {
      earliest = { id: t.id, until }
    }
  }
  if (!earliest) return null

  // 冷却未到期：拒绝
  if (earliest.until > now) return null

  // 冷却已到期但探测位被占用：拒绝
  if (state.probe && state.probe.expiresAt > now) return null

  // 冷却到期且探测位空闲：放行探测
  state.probe = { targetId: earliest.id, expiresAt: now + PROBE_TTL_MS }
  const target = ordered.find((t) => t.id === earliest.id)
  return target ? { target, isProbe: true } : null
}

/** 候选请求成功：清失败计数与冷却，释放探测位；armAffinity 为 true 且配置了亲和时长时进入亲和期。 */
export function reportSuccess(
  aliasKey: string,
  targetId: number,
  config: RoutingConfig,
  options: { armAffinity?: boolean; now?: number } = {},
): void {
  const state = stateFor(aliasKey)
  state.failures.delete(targetId)
  state.cooldowns.delete(targetId)
  if (state.probe?.targetId === targetId) state.probe = null
  const seconds = config.affinity_seconds ?? 0
  if (options.armAffinity && seconds > 0) {
    state.affinity = { targetId, until: (options.now ?? Date.now()) + seconds * 1000 }
  }
}

/** 候选请求失败：连续失败达阈值（max_attempts，默认 1）才进入冷却并清除亲和。 */
export function reportFailure(
  aliasKey: string,
  targetId: number,
  config: RoutingConfig,
  now: number = Date.now(),
): void {
  const state = stateFor(aliasKey)
  if (state.probe?.targetId === targetId) state.probe = null

  const count = (state.failures.get(targetId) ?? 0) + 1
  if (count < failureThreshold(config)) {
    state.failures.set(targetId, count)
    return
  }
  state.failures.delete(targetId)
  const ms = cooldownMs(config)
  if (ms > 0) state.cooldowns.set(targetId, now + ms)
  if (state.affinity?.targetId === targetId) state.affinity = null
}

/** 探测请求被客户端取消：不计失败，但必须释放探测位（对齐 octopus 的 releaseRouteProbe）。 */
export function reportClientCancel(aliasKey: string, targetId: number): void {
  const state = states.get(aliasKey)
  if (!state) return
  if (state.probe?.targetId === targetId) state.probe = null
}

export interface HealthSnapshot {
  cooldowns: Array<{ target_id: number; until: number }>
  probe: { target_id: number; expires_at: number } | null
  affinity: { target_id: number; until: number } | null
}

/** 观测用快照（管理 API / 测试）。 */
export function getHealthSnapshot(aliasKey: string, now: number = Date.now()): HealthSnapshot {
  const state = states.get(aliasKey)
  if (!state) return { cooldowns: [], probe: null, affinity: null }
  const cooldowns = [...state.cooldowns.entries()]
    .filter(([, until]) => until > now)
    .map(([target_id, until]) => ({ target_id, until }))
    .sort((a, b) => a.until - b.until)
  return {
    cooldowns,
    probe: state.probe && state.probe.expiresAt > now
      ? { target_id: state.probe.targetId, expires_at: state.probe.expiresAt }
      : null,
    affinity: state.affinity && state.affinity.until > now
      ? { target_id: state.affinity.targetId, until: state.affinity.until }
      : null,
  }
}

/** 清空状态：不传 key 清全部（配置变更/测试用）。 */
export function clearHealthState(aliasKey?: string): void {
  if (aliasKey === undefined) states.clear()
  else states.delete(aliasKey)
}
