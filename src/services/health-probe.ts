/**
 * 周期性健康探针：对「处于冷却中」的候选发一次极小成本的真实请求，
 * 成功则提前抬起冷却（对齐 LiteLLM 的主动健康检查思路）。
 * 与请求失败计数共享 health.ts 的状态，因此探针失败只会延长冷却，不会误伤正常候选。
 *
 * 通过设置 health_check_interval_seconds 控制，默认 0 = 关闭；
 * 修改设置后无需重启（每轮 tick 重新读取）。探测成本刻意压到最低：max_tokens = 1。
 */

import { db, getSetting } from '../db'
import { parseRoutingConfig } from './routing'
import { getHealthSnapshot, reportFailure, reportSuccess } from './health'
import { buildProviderHeaders } from '../providers/headers'
import { getDispatcher, sendToUpstream, drainBody } from '../proxy'
import { assertSafeOutboundUrl } from './url-guard'
import { getProvider } from './providers'
import type { ProviderProtocol, ProviderRow } from '../types'

const PROBE_TIMEOUT_MS = 30_000
const OFF_POLL_MS = 30_000
const MIN_INTERVAL_SECONDS = 5
const MAX_INTERVAL_SECONDS = 86_400

interface CooledCandidate {
  aliasKey: string
  protocol: ProviderProtocol
  aliasName: string
  targetId: number
  routingConfigJson: string | null
  provider: ProviderRow
  modelId: string
}

function collectCooledCandidates(): CooledCandidate[] {
  const rows = db.prepare(
    `SELECT a.protocol, a.alias_name, a.routing_config_json,
            t.id AS target_id, t.provider_id, t.model_id
     FROM model_aliases a
     JOIN model_alias_targets t ON t.protocol = a.protocol AND t.alias_name = a.alias_name
     JOIN providers p ON p.id = t.provider_id
     JOIN provider_models pm ON pm.provider_id = t.provider_id AND pm.model_id = t.model_id
     WHERE a.enabled = 1 AND p.enabled = 1 AND pm.enabled = 1`,
  ).all() as Array<{
    protocol: ProviderProtocol
    alias_name: string
    routing_config_json: string | null
    target_id: number
    provider_id: string
    model_id: string
  }>

  const out: CooledCandidate[] = []
  for (const row of rows) {
    const aliasKey = `${row.protocol}/${row.alias_name}`
    const snapshot = getHealthSnapshot(aliasKey)
    if (!snapshot.cooldowns.some((entry) => entry.target_id === row.target_id)) continue
    const provider = getProvider(row.provider_id)
    if (!provider) continue
    out.push({
      aliasKey,
      protocol: row.protocol,
      aliasName: row.alias_name,
      targetId: row.target_id,
      routingConfigJson: row.routing_config_json,
      provider,
      modelId: row.model_id,
    })
  }
  return out
}

function probeEndpoint(protocol: ProviderProtocol): string {
  return protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages'
}

function probeBody(protocol: ProviderProtocol, modelId: string): Uint8Array {
  const body = protocol === 'openai'
    ? { model: modelId, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 }
    : { model: modelId, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 }
  return new TextEncoder().encode(JSON.stringify(body))
}

/** 执行一轮探测，返回探测的候选数量。 */
export async function probeCoolingTargetsOnce(): Promise<number> {
  const candidates = collectCooledCandidates()
  for (const candidate of candidates) {
    const config = parseRoutingConfig(candidate.routingConfigJson)
    try {
      const baseUrl = candidate.provider.base_url.replace(/\/+$/, '')
      const url = `${baseUrl}${probeEndpoint(candidate.protocol)}`
      assertSafeOutboundUrl(url)
      const res = await sendToUpstream({
        method: 'POST',
        url,
        headers: { ...buildProviderHeaders(candidate.provider), 'content-type': 'application/json' },
        body: probeBody(candidate.protocol, candidate.modelId),
        dispatcher: getDispatcher(candidate.provider.proxy_url, PROBE_TIMEOUT_MS),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const okStatus = res.status >= 200 && res.status < 300
      await drainBody(res.body)
      if (okStatus) reportSuccess(candidate.aliasKey, candidate.targetId, config, { armAffinity: false })
      else reportFailure(candidate.aliasKey, candidate.targetId, config)
    } catch {
      // 探测失败（超时/网络/上游错误）一律按失败累计：只会延长冷却，不会误伤
      reportFailure(candidate.aliasKey, candidate.targetId, config)
    }
  }
  return candidates.length
}

function currentIntervalSeconds(): number {
  const value = Number(getSetting('health_check_interval_seconds') ?? '0')
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.floor(value)))
}

function tick(): void {
  const intervalSeconds = currentIntervalSeconds()
  if (intervalSeconds <= 0) {
    setTimeout(tick, OFF_POLL_MS).unref()
    return
  }
  void probeCoolingTargetsOnce()
    .then((count) => {
      if (count > 0) console.log(`[health-probe] probed ${count} cooling target(s)`)
    })
    .catch((err) => console.error('[health-probe] probe pass failed:', err))
    .finally(() => setTimeout(tick, intervalSeconds * 1000).unref())
}

export function startHealthProbeScheduler(): void {
  const interval = currentIntervalSeconds()
  console.log(`[health-probe] scheduler started (interval=${interval > 0 ? `${interval}s` : 'off'})`)
  setTimeout(tick, interval > 0 ? interval * 1000 : OFF_POLL_MS).unref()
}
