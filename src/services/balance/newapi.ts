import type { getDispatcher } from '../../proxy'
import type { ProviderRow } from '../../types'
import { UpstreamError } from '../errors'
import { assertSafeOutboundUrl } from '../url-guard'
import type { BalanceResult } from './index'
import {
  billingGet,
  billingRoot,
  localDateString,
  readProviderAuthTokens,
  roundMoney,
  toFiniteNumber,
} from './shared'

/**
 * new-api 对无限额令牌的硬编码哨兵：GetSubscription 在 token.UnlimitedQuota 时
 * 无视实际额度把 *_limit_usd 一律置为 100000000（controller/billing.go）。
 * 精确匹配该值以识别无限额；经典 one-api 用 400 作哨兵，与真实 400 美元额度无法区分，
 * 不做猜测（误判真实额度为无限额比不识别更糟）。
 */
const NEWAPI_UNLIMITED_HARD_LIMIT_USD = 100_000_000

/**
 * new-api 控制台账户余额换算：`GET /api/user/self` 的 `quota`/`used_quota`
 * 为内部额度单位，默认 `common.QuotaPerUnit = 500000`（$1 = 500000 quota）。
 * all-api-hub / newapi-ai-check-in 同用该常数；站点自定义 QuotaPerUnit 时
 * 展示值会偏大/偏小，网关无公开只读接口可稳定读取站点配置，故沿用默认。
 */
const NEWAPI_QUOTA_PER_USD = 500_000

interface NewApiUserBalance {
  balanceUsd: number
  usedUsd: number | null
  status: number
}

/**
 * new-api 系余额总入口：
 * 1. 有 `access_token` 时优先/同时查控制台 `GET /api/user/self`（用户总余额）
 * 2. 有 `api_key` 时继续查 OpenAI 兼容 billing（令牌额度）
 * 两边都成功则合并展示；仅一边成功则只报该侧；都失败抛出更有指向性的错误。
 */
export async function queryNewApiBalance(
  provider: ProviderRow,
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
): Promise<BalanceResult> {
  const { apiKey, accessToken } = readProviderAuthTokens(provider.auth_json)
  if (!apiKey && !accessToken) {
    throw new UpstreamError('upstream_auth_error', 'provider auth_json has no api_key/access_token for balance query')
  }

  let billingResult: BalanceResult | null = null
  let billingError: UpstreamError | null = null
  let userResult: NewApiUserBalance | null = null
  let userError: UpstreamError | null = null

  if (apiKey) {
    try {
      const headers: Record<string, string> = {
        'accept': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      }
      billingResult = await queryNewApiBilling(provider, headers, dispatcher, signal)
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err
      billingError = err
    }
  }

  if (accessToken) {
    try {
      userResult = await queryNewApiUserBalance(provider, accessToken, dispatcher, signal)
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err
      userError = err
    }
  }

  if (userResult) return mergeNewApiBalance(billingResult, userResult)
  if (billingResult) return billingResult
  throw (
    billingError
    ?? userError
    ?? new UpstreamError('upstream_auth_error', 'newapi balance query has no usable credential result')
  )
}

/**
 * new-api 控制台用户总余额：`GET {root}/api/user/self`（UserAuth）。
 * all-api-hub `fetchAccountQuota` 与 newapi-ai-check-in 同源；响应信封
 * `{success, message, data}`，`data.quota`/`data.used_quota` 为内部额度单位。
 * 该端点只接受控制台 PAT/会话 JWT，代理用 sk- 密钥会被 401。
 */
async function queryNewApiUserBalance(
  provider: ProviderRow,
  accessToken: string,
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
): Promise<NewApiUserBalance> {
  const url = `${billingRoot(provider.base_url)}/api/user/self`
  assertSafeOutboundUrl(url)

  const { status, body } = await billingGet(
    url,
    { 'accept': 'application/json', 'authorization': `Bearer ${accessToken}` },
    dispatcher,
    signal,
  )

  // 兼容信封与部分 fork 直接返回用户对象的形态
  const success = body.success
  if (success === false) {
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : 'newapi /api/user/self returned success=false'
    throw new UpstreamError(status === 401 || status === 403 ? 'upstream_auth_error' : 'upstream_error', message, status)
  }
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : body
  const quota = toFiniteNumber(data.quota)
  if (quota === null) {
    throw new UpstreamError('upstream_error', 'newapi /api/user/self response has no numeric quota field', status)
  }
  const usedRaw = toFiniteNumber(data.used_quota)
  return {
    balanceUsd: roundMoney(quota / NEWAPI_QUOTA_PER_USD),
    usedUsd: usedRaw === null ? null : roundMoney(usedRaw / NEWAPI_QUOTA_PER_USD),
    status,
  }
}

/**
 * 合并 newapi 令牌额度与用户总余额。
 * 有 access_token 查到账户余额时，`balance` 以**用户总余额**为准（本功能语义），
 * balances 同时保留用户侧与令牌侧明细；令牌侧标签加「令牌」前缀避免与用户余额混淆。
 */
function mergeNewApiBalance(billing: BalanceResult | null, user: NewApiUserBalance): BalanceResult {
  const balances: BalanceResult['balances'] = [
    { label: '用户余额', balance: user.balanceUsd, currency: 'USD' },
  ]
  if (user.usedUsd !== null) balances.push({ label: '用户已用', balance: user.usedUsd, currency: 'USD' })

  if (billing) {
    for (const item of billing.balances) {
      const label = item.label === '剩余' ? '令牌剩余'
        : item.label === '已用' ? '令牌已用'
          : item.label === '总额' ? '令牌总额'
            : item.label
      balances.push({ ...item, label })
    }
  }

  return {
    success: true,
    balance: user.balanceUsd,
    currency: 'USD',
    balances,
    // 已取到有限的用户总余额时，不因令牌 unlimited 而抹掉账户余额
    unlimited: false,
    available: user.balanceUsd > 0 || billing?.available === true,
    status_code: user.status,
    fetched_at: new Date().toISOString(),
    error: null,
    expires_at: billing?.expires_at ?? null,
  }
}

/**
 * new-api 系令牌额度查询：使用代理密钥（sk-，TokenAuth 中间件）访问 OpenAI 兼容 billing 接口。
 * `GET /api/user/self` 是另一条路径（控制台 UserAuth + access_token），由
 * `queryNewApiUserBalance` 处理用户总余额；sk- 密钥打 user/self 会被 401。
 * 公式与 new-api 自身探测上游渠道一致（controller/channel-billing.go）：
 *   剩余 = hard_limit_usd - total_usage/100（total_usage 单位为美分）。
 * /usage 不可用时降级为只报 subscription 的 hard_limit_usd（总额度）。
 * 无限额令牌（hard_limit_usd === 1e8 哨兵）不报剩余/总额，balance 为 null，
 * balances 只在取得到用量时保留一项「已用」（取不到则为空数组）；语义与 new-api 控制台前端一致。
 */
async function queryNewApiBilling(
  provider: ProviderRow,
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
