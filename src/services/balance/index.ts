import { db } from '../../db'
import { getProvider } from '../providers'
import { getDispatcher } from '../../proxy'
import { UpstreamError } from '../errors'
import { getUpstreamCapabilities, type BalanceMethod } from '../upstream-capabilities'
import type { BalanceSnapshotRow, ProviderRow } from '../../types'
import { queryNewApiBalance } from './newapi'
import { querySub2ApiProfile } from './sub2api'

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
  /** true 表示该密钥在上游为无限额：balance 为 null，balances 仅含用量项 */
  unlimited: boolean
  available: boolean | null
  status_code: number | null
  fetched_at: string
  error: string | null
  /** 上游令牌到期时间（ISO）；上游未返回或永不过期时为 null */
  expires_at: string | null
}

/** 管理面查询走缓存 + 在途去重；TTL 内重复点击不直连上游 */
const BALANCE_TTL_MS = 60_000 // 缓存有效期 60s，平衡实时性与上游负载
const MIN_INTERVAL_MS = 10_000 // 最小查询间隔 10s，防止短时频繁查询

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
    // 无限额（unlimited）没有有限余额，不写余额日快照
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

async function queryBalanceByMethod(provider: ProviderRow, method: BalanceMethod): Promise<BalanceResult> {
  const timeout = provider.timeout_ms || 30_000
  const dispatcher = getDispatcher(provider.proxy_url, timeout)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    if (method === 'newapi_billing') {
      return await queryNewApiBalance(provider, dispatcher, controller.signal)
    }
    return await querySub2ApiProfile(provider, dispatcher, controller.signal)
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
