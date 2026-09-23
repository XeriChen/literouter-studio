import { request } from 'undici'
import { getDispatcher } from '../../proxy'
import { UpstreamError, type UpstreamErrorCode } from '../errors'

export interface ProviderAuthTokens {
  apiKey: string | null
  accessToken: string | null
}

/** 读出 Provider 认证中的 api_key / access_token（余额查询专用，不参与代理转发） */
export function readProviderAuthTokens(authJson: string): ProviderAuthTokens {
  let auth: Record<string, unknown>
  try {
    auth = JSON.parse(authJson) as Record<string, unknown>
  } catch {
    throw new UpstreamError('upstream_error', 'provider auth_json is not valid JSON')
  }
  const apiKey = typeof auth.api_key === 'string' && auth.api_key ? auth.api_key : null
  const accessToken = typeof auth.access_token === 'string' && auth.access_token ? auth.access_token : null
  return { apiKey, accessToken }
}

/**
 * 收集余额查询可用凭据（保序去重）。
 * newapi 系用代理 sk- 密钥（TokenAuth）调 billing 接口；控制台用户总余额用
 * access_token（UserAuth）调 `/api/user/self`。sub2api 的账户端点挂在用户态
 * JWT 认证中间件下，代理用 API Key 只授权 /v1 Relay 路由，因此两类上游的
 * 凭据优先级不同，由 prefer 决定。
 */
export function collectAuthTokens(authJson: string, prefer: 'api_key' | 'access_token'): string[] {
  const { apiKey, accessToken } = readProviderAuthTokens(authJson)
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
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}

export function statusToErrorCode(status: number): UpstreamErrorCode {
  if (status === 401 || status === 403) return 'upstream_auth_error'
  if (status === 429) return 'upstream_rate_limited'
  return 'upstream_error'
}

/**
 * new-api 系（one-api/new-api/veloera 等 fork）的 OpenAI 兼容 billing 接口
 * 在出错时会以 HTTP 200 返回 { error: {...} }（见 new-api controller/billing.go），
 * 需与网络层 200 区分开。
 */
export function describeBillingError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const error = (payload as { error?: unknown }).error
  if (!error) return null
  if (typeof error === 'string') return error
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message ? message : 'upstream billing error'
}

export interface BillingJsonResponse {
  status: number
  body: Record<string, unknown>
}

/** 发起 billing GET 并解析 JSON；非 200、坏 JSON、200 包 error 都抛 UpstreamError。 */
export async function billingGet(
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
export function billingRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/** 本地日期（YYYY-MM-DD），billing/usage 的 start_date/end_date 为可选参数，与 new-api 自身探测保持一致。 */
export function localDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}
