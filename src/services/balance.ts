import { db } from '../db'
import { getProvider } from './providers'
import { getDispatcher } from '../proxy'
import { request } from 'undici'
import { UpstreamError } from './errors'
import { getUpstreamCapabilities, type BalanceMethod } from './upstream-capabilities'
import { assertSafeOutboundUrl } from './url-guard'
import type { BalanceSnapshotRow } from '../types'

/**
 * 归一化余额结果（借鉴 sub2api 的 CNProviderBalanceResult）：
 * success 表达「本次查询是否成功」而不是抛异常丢上下文；
 * balances[] 留给多币种上游泛化；available 表达「账号当前是否可用」。
 */
export interface BalanceResult {
  success: boolean
  balance: number | null
  currency: string | null
  balances: Array<{ label: string; balance: number; currency: string }>
  available: boolean | null
  status_code: number | null
  fetched_at: string
  error: string | null
}

/** 管理面查询走缓存 + 在途去重；TTL 内重复点击不直连上游 */
const BALANCE_TTL_MS = 60_000
const MIN_INTERVAL_MS = 10_000

interface CacheEntry {
  result: BalanceResult
  expiresAt: number
}

const balanceCache = new Map<string, CacheEntry>()
const balanceInflight = new Map<string, Promise<BalanceResult>>()
const lastFetchAt = new Map<string, number>()

/** 供测试清理进程内状态 */
export function resetBalanceRuntimeState(): void {
  balanceCache.clear()
  balanceInflight.clear()
  lastFetchAt.clear()
}

export interface BalanceQueryOptions {
  /** 跳过缓存直连上游（用户显式刷新） */
  force?: boolean
  now?: number
}

export async function getProviderBalance(providerId: string, options: BalanceQueryOptions = {}): Promise<BalanceResult> {
  const now = options.now ?? Date.now()
  if (!options.force) {
    const cached = balanceCache.get(providerId)
    if (cached && cached.expiresAt > now) return cached.result
  }

  // 在途去重（singleflight 语义）：并发请求共享同一次上游查询
  const inflight = balanceInflight.get(providerId)
  if (inflight) return inflight

  const task = (async () => {
    // 最小间隔限流：仅约束非强制查询；force 是用户显式刷新，始终直连上游
    const last = lastFetchAt.get(providerId)
    const cachedAny = balanceCache.get(providerId)
    if (!options.force && last !== undefined && now - last < MIN_INTERVAL_MS) {
      if (cachedAny) return cachedAny.result
      throw new UpstreamError('upstream_error', 'balance query rate limited, retry later')
    }

    const result = await fetchProviderBalance(providerId)
    lastFetchAt.set(providerId, Date.now())
    balanceCache.set(providerId, { result, expiresAt: Date.now() + BALANCE_TTL_MS })
    if (result.success && result.balance !== null) {
      captureDailyBalanceSnapshot(providerId, result)
    }
    return result
  })()

  balanceInflight.set(providerId, task)
  try {
    return await task
  } finally {
    balanceInflight.delete(providerId)
  }
}

async function fetchProviderBalance(providerId: string): Promise<BalanceResult> {
  const provider = getProvider(providerId)
  if (!provider) throw new UpstreamError('provider_not_found', 'provider not found')

  const capability = getUpstreamCapabilities(provider.upstream_type)
  if (!capability.balance.supported) {
    throw new UpstreamError(
      'balance_unsupported',
      capability.balance.reason === 'upstream-type-missing'
        ? 'provider has no upstream_type configured; balance endpoint unknown'
        : 'provider upstream_type does not provide a balance endpoint',
    )
  }

  try {
    const result = await queryBalanceByMethod(provider, capability.balance.method!)
    return result
  } catch (err) {
    if (err instanceof UpstreamError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamError('upstream_timeout', 'balance query request timed out')
    }
    throw new UpstreamError('upstream_error', `failed to fetch balance: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
}

function requireAuthBearer(authJson: string): string {
  let auth: Record<string, unknown>
  try {
    auth = JSON.parse(authJson) as Record<string, unknown>
  } catch {
    throw new UpstreamError('upstream_error', 'provider auth_json is not valid JSON')
  }
  const key = (auth.api_key ?? auth.access_token) as unknown
  if (typeof key !== 'string' || !key) {
    throw new UpstreamError('upstream_auth_error', 'provider auth_json has no api_key/access_token for balance query')
  }
  return key
}

async function queryBalanceByMethod(provider: NonNullable<ReturnType<typeof getProvider>>, method: BalanceMethod): Promise<BalanceResult> {
  const baseUrl = provider.base_url.replace(/\/+$/, '')
  const url = method === 'new_api_token'
    ? `${baseUrl}/api/user/self`
    : `${baseUrl}/api/v1/users/profile`
  assertSafeOutboundUrl(url)

  const headers: Record<string, string> = {
    'accept': 'application/json',
    'authorization': `Bearer ${requireAuthBearer(provider.auth_json)}`,
  }

  const timeout = provider.timeout_ms || 30_000
  const dispatcher = getDispatcher(provider.proxy_url, timeout)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await request(url, { method: 'GET', headers, dispatcher, signal: controller.signal })
    if (response.statusCode !== 200) {
      await response.body.dump()
      const code = response.statusCode === 401 || response.statusCode === 403
        ? 'upstream_auth_error'
        : response.statusCode === 429 ? 'upstream_rate_limited' : 'upstream_error'
      throw new UpstreamError(code, `upstream returned HTTP ${response.statusCode}`, response.statusCode)
    }

    let balance: number | null = null
    const balances: BalanceResult['balances'] = []
    if (method === 'new_api_token') {
      const data = (await response.body.json()) as { quota?: unknown; used_quota?: unknown }
      const quota = typeof data.quota === 'number' ? data.quota : Number(data.quota)
      if (!Number.isFinite(quota)) throw new UpstreamError('upstream_error', 'upstream quota field is not numeric', 200)
      balance = quota / 500_000
      balances.push({ label: 'quota', balance, currency: 'USD' })
    } else {
      const data = (await response.body.json()) as { balance?: unknown }
      const value = typeof data.balance === 'number' ? data.balance : Number(data.balance)
      if (!Number.isFinite(value)) throw new UpstreamError('upstream_error', 'upstream balance field is not numeric', 200)
      balance = value
      balances.push({ label: 'balance', balance, currency: 'USD' })
    }

    return {
      success: true,
      balance,
      currency: 'USD',
      balances,
      available: balance !== null && balance > 0,
      status_code: response.statusCode,
      fetched_at: new Date().toISOString(),
      error: null,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ---------- 余额日快照（借鉴 all-api-hub 的 dailyBalanceHistory） ----------

/** 服务器当地时区的 YYYY-MM-DD；单机部署无需考虑多时区 */
function localDayKey(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function captureDailyBalanceSnapshot(providerId: string, result: BalanceResult, now = new Date()): BalanceSnapshotRow {
  const capturedAt = now.toISOString()
  db.prepare(
    `INSERT INTO balance_snapshots (provider_id, day_key, balance, currency, captured_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, day_key) DO UPDATE SET
       balance = excluded.balance,
       currency = excluded.currency,
       captured_at = excluded.captured_at`,
  ).run(providerId, localDayKey(now), result.balance, result.currency, capturedAt)
  return db.prepare('SELECT * FROM balance_snapshots WHERE provider_id = ? AND day_key = ?').get(providerId, localDayKey(now)) as BalanceSnapshotRow
}

export function listBalanceSnapshots(providerId: string, limitDays = 90): BalanceSnapshotRow[] {
  return db.prepare(
    'SELECT * FROM balance_snapshots WHERE provider_id = ? ORDER BY day_key DESC LIMIT ?',
  ).all(providerId, limitDays) as BalanceSnapshotRow[]
}
