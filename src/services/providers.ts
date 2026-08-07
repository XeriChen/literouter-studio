import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { isTimeoutError, sendToUpstream, getDispatcher, drainBody } from '../proxy'
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
}): ProviderRow {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO providers (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.protocol, input.base_url, input.auth_json, input.custom_headers_json, input.proxy_url, input.timeout_ms, now, now)
  return getProvider(id)!
}

export function updateProvider(id: string, patch: Partial<ProviderRow>): ProviderRow {
  const allowed = ['name', 'base_url', 'auth_json', 'custom_headers_json', 'proxy_url', 'timeout_ms'] as const
  const sets = allowed.filter((k) => patch[k] !== undefined)
  if (sets.length > 0) {
    db.prepare(
      `UPDATE providers SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ).run(...sets.map((k) => patch[k]), new Date().toISOString(), id)
  }
  return getProvider(id)!
}

export function deleteProvider(id: string): void {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id)
}

export function getProviderModelsUrl(provider: ProviderRow): string {
  return provider.protocol === 'openai'
    ? buildOpenAIModelsUrl(provider.base_url)
    : buildAnthropicModelsUrl(provider.base_url)
}

/** 拉取上游模型列表。新增的模型 enabled=0；已存在的保持 source/enabled 不变，仅刷新 fetched_at */
export function fetchProviderModels(providerId: string): Promise<{ added: number; updated: number }> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error('provider not found')
  const url = getProviderModelsUrl(provider)
  const timeoutMs = provider.timeout_ms ?? getGlobalTimeoutMs()
  const dispatcher = getDispatcher(provider.proxy_url, timeoutMs)

  return (async () => {
    const res = await sendToUpstream({
      method: 'GET',
      url,
      headers: buildProviderHeaders(provider),
      signal: AbortSignal.timeout(timeoutMs || 30_000),
      dispatcher,
    })
    try {
      const json = await new Response(res.body as unknown as BodyInit).json().catch(() => null)
      const ids = (json?.data ?? []).map((m: { id?: string }) => m.id).filter((x: unknown): x is string => typeof x === 'string')
      const now = new Date().toISOString()
      const upsert = db.prepare(
        `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, fetched_at, created_at, updated_at)
         VALUES (?, ?, NULL, 0, 'fetched', ?, ?, ?)
         ON CONFLICT(provider_id, model_id) DO UPDATE SET fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`,
      )
      const tx = db.transaction((idsToUpsert: string[]) => {
        let added = 0
        let updated = 0
        const existsStmt = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?')
        for (const id of idsToUpsert) {
          const existed = existsStmt.get(providerId, id) !== undefined
          upsert.run(providerId, id, now, now, now)
          if (existed) updated++
          else added++
        }
        return { added, updated }
      })
      return tx(ids)
    } finally {
      await drainBody(res.body)
    }
  })()
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