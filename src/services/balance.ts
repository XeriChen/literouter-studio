import { db } from '../db'
import { getProvider } from './providers'
import { getDispatcher } from '../proxy'
import { request } from 'undici'
import { UpstreamError, type UpstreamErrorCode } from './errors'
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
  /** true 表示该密钥在上游为无限额：balance 为 null，balances 仅含用量项 */
  unlimited: boolean
  available: boolean | null
  status_code: number | null
  fetched_at: string
  error: string | null
  /** 上游令牌到期时间（ISO）；上游未返回或永不过期时为 null */
  expires_at: string | null
}

/**
 * new-api 对无限额令牌的硬编码哨兵：GetSubscription 在 token.UnlimitedQuota 时
 * 无视实际额度把 *_limit_usd 一律置为 100000000（controller/billing.go）。
 * 精确匹配该值以识别无限额；经典 one-api 用 400 作哨兵，与真实 400 美元额度无法区分，
 * 不做猜测（误判真实额度为无限额比不识别更糟）。
 */
const NEWAPI_UNLIMITED_HARD_LIMIT_USD = 100_000_000

/** sub2api `/v1/usage` 的套餐模式：unrestricted = 不限额（remaining 为 -1 或极大钱包值） */
const SUB2API_UNRESTRICTED_MODE = 'unrestricted'
/** sub2api 套餐限额窗口：limit 为 0 表示该窗口不限额 */
const SUB2API_QUOTA_WINDOWS = [
  { label: '日', limitKey: 'daily_limit_usd', usageKey: 'daily_usage_usd' },
  { label: '周', limitKey: 'weekly_limit_usd', usageKey: 'weekly_usage_usd' },
  { label: '月', limitKey: 'monthly_limit_usd', usageKey: 'monthly_usage_usd' },
] as const
/** sub2api 用远未来时间戳表示「永不过期」；2100 及以后按无到期处理 */
const SUB2API_NEVER_EXPIRES_YEAR = 2100

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

/**
 * 收集余额查询可用凭据（保序去重）。
 * newapi 系用代理 sk- 密钥（TokenAuth）调 billing 接口；sub2api 的账户端点挂在
 * 用户态 JWT 认证中间件下，代理用 API Key 只授权 /v1 Relay 路由，因此两类上游的
 * 凭据优先级不同，由 prefer 决定。
 */
function collectAuthTokens(authJson: string, prefer: 'api_key' | 'access_token'): string[] {
  let auth: Record<string, unknown>
  try {
    auth = JSON.parse(authJson) as Record<string, unknown>
  } catch {
    throw new UpstreamError('upstream_error', 'provider auth_json is not valid JSON')
  }
  const apiKey = typeof auth.api_key === 'string' ? auth.api_key : ''
  const accessToken = typeof auth.access_token === 'string' ? auth.access_token : ''
  const ordered = prefer === 'access_token' ? [accessToken, apiKey] : [apiKey, accessToken]
  const tokens: string[] = []
  for (const token of ordered) {
    if (token && !tokens.includes(token)) tokens.push(token)
  }
  if (tokens.length === 0) {
    throw new UpstreamError('upstream_auth_error', 'provider auth_json has no api_key/access_token for balance query')
  }
  return tokens
}

/** 金额浮点归一：billing 字段是除法/减法结果，避免 0.30000000000000004 类噪声 */
function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}

function statusToErrorCode(status: number): UpstreamErrorCode {
  if (status === 401 || status === 403) return 'upstream_auth_error'
  if (status === 429) return 'upstream_rate_limited'
  return 'upstream_error'
}

/**
 * new-api 系（one-api/new-api/veloera 等 fork）的 OpenAI 兼容 billing 接口
 * 在出错时会以 HTTP 200 返回 { error: {...} }（见 new-api controller/billing.go），
 * 需与网络层 200 区分开。
 */
function describeBillingError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const error = (payload as { error?: unknown }).error
  if (!error) return null
  if (typeof error === 'string') return error
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message ? message : 'upstream billing error'
}

interface BillingJsonResponse {
  status: number
  body: Record<string, unknown>
}

/** 发起 billing GET 并解析 JSON；非 200、坏 JSON、200 包 error 都抛 UpstreamError。 */
async function billingGet(
  url: string,
  headers: Record<string, string>,
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
): Promise<BillingJsonResponse> {
  const response = await request(url, { method: 'GET', headers, dispatcher, signal })
  if (response.statusCode !== 200) {
    await response.body.dump()
    throw new UpstreamError(
      statusToErrorCode(response.statusCode),
      `upstream returned HTTP ${response.statusCode}`,
      response.statusCode,
    )
  }

  let json: unknown
  try {
    json = await response.body.json()
  } catch {
    throw new UpstreamError('upstream_error', 'upstream balance response is not valid JSON', 200)
  }
  const billingError = describeBillingError(json)
  if (billingError) throw new UpstreamError('upstream_error', billingError, 200)
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new UpstreamError('upstream_error', 'upstream balance response has unexpected shape', 200)
  }
  return { status: response.statusCode, body: json as Record<string, unknown> }
}

/** 去掉尾部斜杠与单个结尾 /v1：billing 路由在 new-api 上同时注册 /v1/dashboard 与 /dashboard。 */
function billingRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/** 本地日期（YYYY-MM-DD），billing/usage 的 start_date/end_date 为可选参数，与 new-api 自身探测保持一致。 */
function localDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

async function queryBalanceByMethod(provider: NonNullable<ReturnType<typeof getProvider>>, method: BalanceMethod): Promise<BalanceResult> {
  const timeout = provider.timeout_ms || 30_000
  const dispatcher = getDispatcher(provider.proxy_url, timeout)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    if (method === 'newapi_billing') {
      const headers: Record<string, string> = {
        'accept': 'application/json',
        'authorization': `Bearer ${collectAuthTokens(provider.auth_json, 'api_key')[0]}`,
      }
      return await queryNewApiBilling(provider, headers, dispatcher, controller.signal)
    }
    return await querySub2ApiProfile(provider, dispatcher, controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * new-api 系余额查询：使用代理密钥（sk-，TokenAuth 中间件）访问 OpenAI 兼容 billing 接口。
 * 不能用 GET /api/user/self——那是控制台 PAT/会话令牌（UserAuth），sk- 密钥会被 401。
 * 公式与 new-api 自身探测上游渠道一致（controller/channel-billing.go）：
 *   剩余 = hard_limit_usd - total_usage/100（total_usage 单位为美分）。
 * /usage 不可用时降级为只报 subscription 的 hard_limit_usd（总额度）。
 * 无限额令牌（hard_limit_usd === 1e8 哨兵）不报剩余/总额，balance 为 null，
 * balances 只在取得到用量时保留一项「已用」（取不到则为空数组）；语义与 new-api 控制台前端一致。
 */
async function queryNewApiBilling(
  provider: NonNullable<ReturnType<typeof getProvider>>,
  headers: Record<string, string>,
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
): Promise<BalanceResult> {
  const root = billingRoot(provider.base_url)
  const now = new Date()
  const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const endDate = localDateString(now)
  const subscriptionUrl = `${root}/v1/dashboard/billing/subscription`
  const usageUrl = `${root}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`
  assertSafeOutboundUrl(subscriptionUrl)
  assertSafeOutboundUrl(usageUrl)

  // subscription 是必要数据（也承担密钥有效性校验）；usage 仅用于拆分已用额度，
  // 其任何上游错误（含 404/401，部分 fork 不实现或限制该路径）都降级为「只报总额」。
  // AbortError（超时）不吞，交给外层归一为 upstream_timeout。
  const [subscription, usage] = await Promise.all([
    billingGet(subscriptionUrl, headers, dispatcher, signal),
    billingGet(usageUrl, headers, dispatcher, signal).catch((err): null => {
      if (err instanceof UpstreamError) return null
      throw err
    }),
  ])

  const totalQuota = toFiniteNumber(subscription.body.hard_limit_usd)
  if (totalQuota === null) {
    throw new UpstreamError('upstream_error', 'upstream hard_limit_usd field is missing or non-numeric', 200)
  }

  const usedRaw = usage ? toFiniteNumber(usage.body.total_usage) : null
  // total_usage 单位 0.01 美元；取不到已用额度时为 null
  const usedQuota = usedRaw === null ? null : roundMoney(usedRaw / 100)

  // access_until 为令牌到期 unix 秒；0/缺省表示永不过期
  const accessUntil = toFiniteNumber(subscription.body.access_until)
  let expiresAt: string | null = null
  if (accessUntil !== null && accessUntil > 0) expiresAt = new Date(accessUntil * 1000).toISOString()

  // 无限额哨兵：剩余/总额无意义（哨兵是固定假值），只统计用量；
  // usage 也不可用时 balances 为空数组，调用方仅凭 unlimited=true 展示「无限额」。
  if (totalQuota === NEWAPI_UNLIMITED_HARD_LIMIT_USD) {
    const balances: BalanceResult['balances'] =
      usedQuota === null ? [] : [{ label: '已用', balance: usedQuota, currency: 'USD' }]
    return {
      success: true,
      balance: null,
      // new-api 在 CNY/Tokens 展示模式下 *_usd 字段实际并非美元，调用方无从识别，沿用 USD 标签（架构文档已留痕）
      currency: 'USD',
      balances,
      unlimited: true,
      available: true,
      status_code: subscription.status,
      fetched_at: new Date().toISOString(),
      error: null,
      expires_at: expiresAt,
    }
  }

  // 取不到已用额度时余额只能按总额度展示
  const remaining = usedQuota === null ? roundMoney(totalQuota) : roundMoney(Math.max(0, totalQuota - usedQuota))

  const balances: BalanceResult['balances'] = [{ label: '剩余', balance: remaining, currency: 'USD' }]
  if (usedQuota !== null) balances.push({ label: '已用', balance: usedQuota, currency: 'USD' })
  balances.push({ label: '总额', balance: roundMoney(totalQuota), currency: 'USD' })

  return {
    success: true,
    balance: remaining,
    currency: 'USD',
    balances,
    unlimited: false,
    available: remaining > 0,
    status_code: subscription.status,
    fetched_at: new Date().toISOString(),
    error: null,
    expires_at: expiresAt,
  }
}

/**
 * sub2api 余额/额度查询。
 *
 * 主路径是数据面 `GET {base}/v1/usage`：与推理同源、代理用的 sk- 密钥即可访问，
 * 一次性给出 remaining / mode / 套餐限额（日周月）/ 已用成本 / 到期时间
 * （cc-switch 的用量脚本打的也是这个端点）。部分部署对该路由同样只放行 JWT，
 * 此时回退控制台 `GET {base}/api/v1/auth/me`（需要 access_token）。
 */
async function querySub2ApiProfile(
  provider: NonNullable<ReturnType<typeof getProvider>>,
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
): Promise<BalanceResult> {
  const tokens = collectAuthTokens(provider.auth_json, 'access_token')
  const apiKey = providerApiKey(provider)
  let usageAuthError: UpstreamError | null = null

  if (apiKey) {
    try {
      return await querySub2ApiUsage(provider, apiKey, dispatcher, signal)
    } catch (err) {
      if (!(err instanceof UpstreamError) || err.code !== 'upstream_auth_error') throw err
      usageAuthError = err
    }
  }

  // 只有 API Key 时没必要用同一把 key 再打一次控制台端点（必然同样 401）
  if (tokens.some((token) => token !== apiKey)) {
    return await querySub2ApiConsoleProfile(provider, tokens, dispatcher, signal)
  }

  throw new UpstreamError(
    'upstream_auth_error',
    `${usageAuthError?.message ?? 'sub2api rejected the API key'}; the console access token (JWT) is required`,
    usageAuthError?.upstreamStatus ?? null,
  )
}

/**
 * sub2api 数据面用量/额度：`GET {base}/v1/usage`（Bearer = 代理 API Key）。
 *
 * 实测两种套餐形态：
 * - 公益/拼车：`{mode:"unrestricted", remaining:-1, planName, subscription:{*_limit_usd,*_usage_usd,expires_at}}`
 * - 钱包余额：`{mode:"unrestricted", balance, remaining, planName:"钱包余额", usage:{total:{cost}}}`
 * 无限额以 `mode === "unrestricted"` 或 `remaining < 0` 判定，与上游语义一致；
 * `remaining` 非负时即剩余额度，否则用「限额 - 窗口用量」里最紧的一档、再退到 balance 兜底。
 */
async function querySub2ApiUsage(
  provider: NonNullable<ReturnType<typeof getProvider>>,
  apiKey: string,
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
): Promise<BalanceResult> {
  const url = `${billingRoot(provider.base_url)}/v1/usage`
  assertSafeOutboundUrl(url)

  const { status, body } = await billingGet(
    url,
    { 'accept': 'application/json', 'authorization': `Bearer ${apiKey}` },
    dispatcher,
    signal,
  )

  const unlimited = body.mode === SUB2API_UNRESTRICTED_MODE || (toFiniteNumber(body.remaining) ?? 0) < 0
  const usageTotal = body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage)
    ? (body.usage as { total?: { cost?: unknown } }).total
    : null
  const usedRaw = usageTotal && typeof usageTotal === 'object' ? toFiniteNumber(usageTotal.cost) : null
  const usedQuota = usedRaw === null ? null : roundMoney(usedRaw)

  const balances: BalanceResult['balances'] = []
  let remaining: number | null = null
  if (!unlimited) {
    const declared = toFiniteNumber(body.remaining)
    if (declared !== null && declared >= 0) remaining = roundMoney(declared)
    const subscription = body.subscription && typeof body.subscription === 'object' && !Array.isArray(body.subscription)
      ? body.subscription as Record<string, unknown>
      : null
    if (subscription) {
      let tightest: number | null = null
      for (const window of SUB2API_QUOTA_WINDOWS) {
        const limit = toFiniteNumber(subscription[window.limitKey])
        if (limit === null || limit <= 0) continue // 0 = 该窗口不限额
        const windowUsage = toFiniteNumber(subscription[window.usageKey]) ?? 0
        balances.push({ label: `${window.label}限额`, balance: roundMoney(limit), currency: 'USD' })
        const windowRemaining = roundMoney(Math.max(0, limit - windowUsage))
        if (tightest === null || windowRemaining < tightest) tightest = windowRemaining
      }
      // 上游没给 remaining 时，用最紧的限额窗口推算
      if (remaining === null && tightest !== null) remaining = tightest
    }
    if (remaining === null) {
      const wallet = toFiniteNumber(body.balance)
      if (wallet !== null && wallet >= 0) remaining = roundMoney(wallet)
    }
  }

  if (remaining !== null) balances.push({ label: '剩余', balance: remaining, currency: 'USD' })
  if (usedQuota !== null) balances.push({ label: '已用', balance: usedQuota, currency: 'USD' })

  return {
    success: true,
    balance: unlimited ? null : remaining,
    currency: 'USD',
    balances,
    unlimited,
    available: unlimited ? true : remaining !== null && remaining > 0,
    status_code: status,
    fetched_at: new Date().toISOString(),
    error: null,
    expires_at: parseSub2ApiExpiry(body.subscription),
  }
}

/** sub2api 用远未来时间戳表示「永不过期」；2100 及以后按无到期处理 */
function parseSub2ApiExpiry(subscription: unknown): string | null {
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) return null
  const raw = (subscription as { expires_at?: unknown }).expires_at
  const numeric = toFiniteNumber(raw)
  const date = numeric !== null
    ? new Date(numeric > 1e11 ? numeric : numeric * 1000)
    : typeof raw === 'string' && raw.trim() ? new Date(raw.trim()) : null
  if (!date || Number.isNaN(date.getTime())) return null
  if (date.getFullYear() >= SUB2API_NEVER_EXPIRES_YEAR) return null
  return date.toISOString()
}

/**
 * sub2api 控制台账户端点：`GET {base}/api/v1/auth/me` 返回 `{code, message, data}` 信封，
 * `data.balance` 为美元余额（与 all-api-hub 的 sub2api 适配器同一端点、同一语义）。
 * 该路由挂在用户态 JWT 认证中间件下，转发代理用的 sk- API Key 只授权 /v1 Relay 路由，
 * 因此凭据顺序为 access_token（控制台登录 JWT）优先，api_key 作为兼容回退——
 * 某些部署对两种凭据都放行，401/403 时换下一把再试。
 */
async function querySub2ApiConsoleProfile(
  provider: NonNullable<ReturnType<typeof getProvider>>,
  tokens: string[],
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
): Promise<BalanceResult> {
  const url = `${provider.base_url.replace(/\/+$/, '')}/api/v1/auth/me`
  assertSafeOutboundUrl(url)

  const apiKey = providerApiKey(provider)
  let lastAuthError: UpstreamError | null = null

  for (let index = 0; index < tokens.length; index++) {
    try {
      const { status, body } = await billingGet(
        url,
        { 'accept': 'application/json', 'authorization': `Bearer ${tokens[index]}` },
        dispatcher,
        signal,
      )
      const data = unwrapSub2ApiEnvelope(body)
      const balance = toFiniteNumber(data.balance)
      if (balance === null) {
        throw new UpstreamError('upstream_error', 'sub2api /api/v1/auth/me response has no numeric balance field', 200)
      }

      return {
        success: true,
        balance,
        currency: 'USD',
        balances: [{ label: 'balance', balance, currency: 'USD' }],
        unlimited: false,
        available: balance > 0,
        status_code: status,
        fetched_at: new Date().toISOString(),
        error: null,
        expires_at: null,
      }
    } catch (err) {
      // 401/403 只说明这把凭据不被接受，还有备用凭据时就地换一把重试
      if (err instanceof UpstreamError && err.code === 'upstream_auth_error' && index < tokens.length - 1) {
        lastAuthError = err
        continue
      }
      // 以 API Key 收尾时给出指向性提示：控制台端点要的是登录 JWT，不是 /v1 用的 sk- 密钥
      if (err instanceof UpstreamError && err.code === 'upstream_auth_error' && tokens[index] === apiKey) {
        throw new UpstreamError(
          'upstream_auth_error',
          `${err.message}; sub2api console endpoint authenticates the login JWT, not the /v1 API key`,
          err.upstreamStatus,
        )
      }
      throw err
    }
  }

  throw lastAuthError ?? new UpstreamError('upstream_auth_error', 'sub2api rejected every configured credential')
}

/** 取 Provider 配置里的 api_key（仅用于组装更具指向性的错误提示） */
function providerApiKey(provider: NonNullable<ReturnType<typeof getProvider>>): string | null {
  try {
    const auth = JSON.parse(provider.auth_json) as Record<string, unknown>
    return typeof auth.api_key === 'string' && auth.api_key ? auth.api_key : null
  } catch {
    return null
  }
}

/**
 * sub2api 信封解包：HTTP 200 也可能带 `{code != 0, message}` 表示业务错误
 * （见 Wei-Shaw/sub2api backend/internal/pkg/response/response.go），与 new-api 的
 * `{error}` 体是两套约定。无信封时退回原始对象，兼容直接返回 balance 的部署。
 */
function unwrapSub2ApiEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const code = toFiniteNumber(body.code)
  if (code !== null && code !== 0) {
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : 'sub2api returned a business error'
    throw new UpstreamError(
      code === 401 || code === 403 ? 'upstream_auth_error' : 'upstream_error',
      `sub2api error ${code}: ${message}`,
      code,
    )
  }
  const data = body.data
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  return body
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
