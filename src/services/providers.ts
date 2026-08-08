import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { isTimeoutError, sendToUpstream, getDispatcher, drainBody, invalidateAllDispatchers } from '../proxy'
import { buildAnthropicModelsUrl } from '../providers/anthropic'
import { buildOpenAIModelsUrl } from '../providers/openai'
import { buildProviderHeaders } from '../providers/headers'
import { getGlobalTimeoutMs } from './settings'
import type { ProviderProtocol, ProviderRow } from '../types'

export function getFirstEnabledProvider(protocol: 'openai' | 'anthropic'): ProviderRow | undefined {
  return db
    .prepare('SELECT * FROM providers WHERE protocol = ? AND enabled = 1 ORDER BY created_at ASC LIMIT 1')
    .get(protocol) as ProviderRow | undefined
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
    `INSERT INTO providers (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.protocol, input.base_url, input.auth_json, input.custom_headers_json, input.proxy_url, input.timeout_ms, input.model_filter, now, now)
  return getProvider(id)!
}

export function updateProvider(id: string, patch: Partial<ProviderRow>): ProviderRow {
  const allowed = ['name', 'base_url', 'auth_json', 'custom_headers_json', 'proxy_url', 'timeout_ms', 'model_filter'] as const
  const sets = allowed.filter((k) => patch[k] !== undefined)
  if (sets.length > 0) {
    db.prepare(
      `UPDATE providers SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ).run(...sets.map((k) => patch[k]), new Date().toISOString(), id)
  }
  // proxy_url / timeout_ms 变更后旧 dispatcher 不再匹配，清空缓存让下次请求重建
  if (sets.includes('proxy_url') || sets.includes('timeout_ms')) {
    invalidateAllDispatchers()
  }
  return getProvider(id)!
}

export function deleteProvider(id: string): void {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id)
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
    const chunks: Buffer[] = []
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf-8')
    const json = JSON.parse(raw) as { data?: { id?: string }[] } | null
    const allIds = (json?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string')
    return allIds.filter((id) => matchesFilter(id, provider.model_filter))
  } finally {
    await drainBody(res.body)
  }
}

/** 将选中的模型 ID 写入数据库。新增 enabled=1；已存在的仅刷新 fetched_at；同时自动建立同名映射（已有不覆盖） */
export function importModels(providerId: string, modelIds: string[]): { added: number; updated: number } {
  const now = new Date().toISOString()
  const provider = getProvider(providerId)
  if (!provider) throw new Error('provider not found')
  const upsert = db.prepare(
    `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, fetched_at, created_at, updated_at)
     VALUES (?, ?, NULL, 1, 'fetched', ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET enabled = 1, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`,
  )
  const insertAlias = db.prepare(
    `INSERT OR IGNORE INTO model_aliases (protocol, alias_name, provider_id, model_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction((ids: string[]) => {
    let added = 0
    let updated = 0
    const existsStmt = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?')
    for (const id of ids) {
      const existed = existsStmt.get(providerId, id) !== undefined
      upsert.run(providerId, id, now, now, now)
      insertAlias.run(provider.protocol, id, providerId, id, now, now)
      if (existed) updated++
      else added++
    }
    return { added, updated }
  })
  return tx(modelIds)
}

/** 网络连通性测试：收到任意 HTTP 响应（含 404）即可达；401/403 为认证失败；网络异常/超时/5xx 为失败 */
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