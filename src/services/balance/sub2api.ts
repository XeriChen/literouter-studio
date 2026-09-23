import type { getDispatcher } from '../../proxy'
import type { ProviderRow } from '../../types'
import { UpstreamError } from '../errors'
import { assertSafeOutboundUrl } from '../url-guard'
import type { BalanceResult } from './index'
import {
  billingGet,
  billingRoot,
  collectAuthTokens,
  readProviderAuthTokens,
  roundMoney,
  toFiniteNumber,
} from './shared'

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

/**
 * sub2api 余额/额度查询。
 *
 * 主路径是数据面 `GET {base}/v1/usage`：与推理同源、代理用的 sk- 密钥即可访问，
 * 一次性给出 remaining / mode / 套餐限额（日周月）/ 已用成本 / 到期时间
 * （cc-switch 的用量脚本打的也是这个端点）。配置了 access_token 时还会查
 * 控制台 `GET {base}/api/v1/auth/me` 取**用户总余额**并合并展示；
 * `/v1/usage` 被拒时回退控制台端点。
 */
export async function querySub2ApiProfile(
  provider: ProviderRow,
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
): Promise<BalanceResult> {
  const tokens = collectAuthTokens(provider.auth_json, 'access_token')
  const apiKey = providerApiKey(provider)
  const accessToken = readProviderAuthTokens(provider.auth_json).accessToken
  let usageAuthError: UpstreamError | null = null
  let usageResult: BalanceResult | null = null

  if (apiKey) {
    try {
      usageResult = await querySub2ApiUsage(provider, apiKey, dispatcher, signal)
    } catch (err) {
      if (!(err instanceof UpstreamError) || err.code !== 'upstream_auth_error') throw err
      usageAuthError = err
    }
  }

  // access_token ≠ 代理 API Key 时，额外取用户账户总余额（all-api-hub 同端点）
  if (accessToken && accessToken !== apiKey) {
    try {
      const consoleResult = await querySub2ApiConsoleProfile(provider, [accessToken], dispatcher, signal)
      if (usageResult) return mergeSub2ApiUserBalance(usageResult, consoleResult)
      return consoleResult
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err
      // 控制台侧失败不掩盖已成功的数据面结果；数据面也失败时才抛出
      if (usageResult) return usageResult
      if (err.code !== 'upstream_auth_error') throw err
      usageAuthError = err
    }
  }

  if (usageResult) return usageResult

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

/** 把 sub2api 控制台用户总余额合并进数据面套餐/用量结果 */
function mergeSub2ApiUserBalance(usage: BalanceResult, user: BalanceResult): BalanceResult {
  const balances: BalanceResult['balances'] = [
    { label: '用户余额', balance: user.balance ?? 0, currency: 'USD' },
  ]
  for (const item of usage.balances) {
    balances.push(item)
  }
  return {
    ...usage,
    // 用户账户余额存在时优先作为主余额展示
    balance: user.balance ?? usage.balance,
    balances,
    unlimited: usage.unlimited && user.balance === null,
    available: (user.balance !== null && user.balance > 0) || usage.available === true,
  }
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
  provider: ProviderRow,
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
  provider: ProviderRow,
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
        balances: [{ label: '用户余额', balance, currency: 'USD' }],
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
function providerApiKey(provider: ProviderRow): string | null {
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
