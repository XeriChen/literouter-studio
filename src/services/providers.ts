import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { isTimeoutError, sendToUpstream, getDispatcher, drainBody, invalidateAllDispatchers } from '../proxy'
import { MAX_UPSTREAM_MODELS_BODY_BYTES } from '../proxy/body'
import { buildAnthropicModelsUrl } from '../providers/anthropic'
import { buildOpenAIModelsUrl } from '../providers/openai'
import { buildProviderHeaders } from '../providers/headers'
import { getGlobalTimeoutMs } from './settings'
import { importModels as importModelsForProvider, repairAliasTargetsInTransaction } from './models'
import type { ProviderGroupRow, ProviderProtocol, ProviderRow } from '../types'

export interface ProviderGroupWithStats extends ProviderGroupRow {
  provider_count: number
  enabled_count: number
}

export function listProviderGroups(): ProviderGroupWithStats[] {
  return db.prepare(
    `SELECT g.*,
       COUNT(p.id) AS provider_count,
       COALESCE(SUM(CASE WHEN p.enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled_count
     FROM provider_groups g
     LEFT JOIN providers p ON p.protocol = g.protocol AND p.group_id = g.id
     GROUP BY g.protocol, g.id
     ORDER BY g.protocol ASC, g.created_at ASC, g.name ASC`,
  ).all() as ProviderGroupWithStats[]
}

export function getProviderGroup(protocol: ProviderProtocol, id: string): ProviderGroupRow | undefined {
  return db.prepare('SELECT * FROM provider_groups WHERE protocol = ? AND id = ?').get(protocol, id) as ProviderGroupRow | undefined
}

export function createProviderGroup(input: { protocol: ProviderProtocol; name: string }): ProviderGroupRow {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO provider_groups (protocol, id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(input.protocol, id, input.name, now, now)
  return getProviderGroup(input.protocol, id)!
}

export function updateProviderGroup(input: { protocol: ProviderProtocol; id: string; name: string }): ProviderGroupRow {
  db.prepare(
    'UPDATE provider_groups SET name = ?, updated_at = ? WHERE protocol = ? AND id = ?',
  ).run(input.name, new Date().toISOString(), input.protocol, input.id)
  return getProviderGroup(input.protocol, input.id)!
}

export function deleteProviderGroup(input: { protocol: ProviderProtocol; id: string }): number {
  return db.transaction(() => {
    const result = db.prepare(
      'UPDATE providers SET group_id = NULL, updated_at = ? WHERE protocol = ? AND group_id = ?',
    ).run(new Date().toISOString(), input.protocol, input.id)
    db.prepare('DELETE FROM provider_groups WHERE protocol = ? AND id = ?').run(input.protocol, input.id)
    return result.changes
  })()
}

export function enableGroupProviders(input: { protocol: ProviderProtocol; group_id: string }): number {
  return setGroupProvidersEnabled(input, 1)
}

export function setGroupProvidersEnabled(input: { protocol: ProviderProtocol; group_id: string }, enabled: 0 | 1): number {
  return db.transaction(() => {
    const result = db.prepare(
      'UPDATE providers SET enabled = ?, updated_at = ? WHERE protocol = ? AND group_id = ? AND enabled <> ?',
    ).run(enabled, new Date().toISOString(), input.protocol, input.group_id, enabled)
    repairAliasTargetsInTransaction()
    return result.changes
  })()
}

export function deleteGroupProviders(input: { protocol: ProviderProtocol; group_id: string }): number {
  const deleted = db.transaction(() => {
    const result = db.prepare('DELETE FROM providers WHERE protocol = ? AND group_id = ?').run(input.protocol, input.group_id)
    repairAliasTargetsInTransaction()
    return result.changes
  })()
  invalidateAllDispatchers()
  return deleted
}

export function listProviders(): ProviderRow[] {
  return db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all() as ProviderRow[]
}

export function getProvider(id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
}

export function createProvider(input: {
  name: string
  protocol: ProviderProtocol
  group_id: string | null
  base_url: string
  auth_json: string
  custom_headers_json: string
  proxy_url: string | null
  timeout_ms: number | null
  model_filter: string | null
}): ProviderRow {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO providers (id, name, protocol, group_id, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.protocol, input.group_id, input.base_url, input.auth_json, input.custom_headers_json, input.proxy_url, input.timeout_ms, input.model_filter, now, now)
  return getProvider(id)!
}

export function updateProvider(id: string, patch: Partial<ProviderRow>): ProviderRow {
  const allowed = ['name', 'group_id', 'base_url', 'auth_json', 'custom_headers_json', 'proxy_url', 'timeout_ms', 'model_filter', 'enabled'] as const
  const sets = allowed.filter((k) => patch[k] !== undefined)
  db.transaction(() => {
    if (sets.length > 0) {
      db.prepare(
        `UPDATE providers SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ).run(...sets.map((k) => patch[k]), new Date().toISOString(), id)
    }
    if (sets.includes('enabled')) repairAliasTargetsInTransaction()
  })()
  // proxy_url / timeout_ms 变更后旧 dispatcher 不再匹配，清空缓存让下次请求重建
  if (sets.includes('proxy_url') || sets.includes('timeout_ms')) {
    invalidateAllDispatchers()
  }
  return getProvider(id)!
}

export function deleteProvider(id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM providers WHERE id = ?').run(id)
    repairAliasTargetsInTransaction()
  })()
  invalidateAllDispatchers()
}

export function getProviderModelsUrl(provider: ProviderRow): string {
  return provider.protocol === 'openai'
    ? buildOpenAIModelsUrl(provider.base_url)
    : buildAnthropicModelsUrl(provider.base_url)
}

function matchesFilter(modelId: string, filter: string | null): boolean {
  if (!filter) return true
  const patterns = filter.split(',').map((p) => p.trim()).filter(Boolean)
  if (!patterns.length) return true
  return patterns.some((p) => {
    if (p.endsWith('*')) return modelId.startsWith(p.slice(0, -1))
    if (p.startsWith('*')) return modelId.endsWith(p.slice(1))
    return modelId === p
  })
}

/** 从上游拉取模型 ID 列表（不入库），应用 model_filter */
export async function listUpstreamModels(providerId: string): Promise<string[]> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error('provider not found')
  const url = getProviderModelsUrl(provider)
  const timeoutMs = provider.timeout_ms ?? getGlobalTimeoutMs()
  const dispatcher = getDispatcher(provider.proxy_url, timeoutMs)

  const res = await sendToUpstream({
    method: 'GET',
    url,
    headers: buildProviderHeaders(provider),
    signal: AbortSignal.timeout(timeoutMs || 30_000),
    dispatcher,
  })
  try {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`upstream returned HTTP ${res.status}`)
    }
    const chunks: Buffer[] = []
    let accumulated = 0
    for await (const chunk of res.body) {
      accumulated += chunk.length
      if (accumulated > MAX_UPSTREAM_MODELS_BODY_BYTES) {
        throw new Error(`upstream model list body too large (max ${MAX_UPSTREAM_MODELS_BODY_BYTES} bytes)`)
      }
      chunks.push(Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString('utf-8')
    const json = JSON.parse(raw) as { data?: unknown } | null
    if (!json || !Array.isArray(json.data)) throw new Error('invalid upstream model list')
    const allIds = json.data
      .map((model) => model && typeof model === 'object' ? (model as { id?: unknown }).id : null)
      .filter((id): id is string => typeof id === 'string')
    return allIds.filter((id) => matchesFilter(id, provider.model_filter))
  } finally {
    await drainBody(res.body)
  }
}

/** 将选中的模型 ID 写入数据库并维护同名映射候选。 */
export function importModels(providerId: string, modelIds: string[]): { added: number; updated: number } {
  return importModelsForProvider(providerId, modelIds)
}

/** 网络连通性测试：401/403 视为认证失败；其余 HTTP 响应表示网络可达，网络异常/超时为失败。 */
export async function testProviderConnection(providerId: string): Promise<{
  ok: boolean
  status?: number
  message: string
}> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error('provider not found')
  const url = getProviderModelsUrl(provider)
  const timeoutMs = provider.timeout_ms ?? getGlobalTimeoutMs()
  try {
    const res = await sendToUpstream({
      method: 'GET',
      url,
      headers: buildProviderHeaders(provider),
      signal: AbortSignal.timeout(timeoutMs || 30_000),
      dispatcher: getDispatcher(provider.proxy_url, timeoutMs),
    })
    await drainBody(res.body)
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, message: `认证失败 (HTTP ${res.status})` }
    }
    return { ok: true, status: res.status, message: `网络可达 (HTTP ${res.status})` }
  } catch (err) {
    if (isTimeoutError(err)) return { ok: false, message: '连接超时' }
    return { ok: false, message: err instanceof Error ? err.message : '连接失败' }
  }
}
