/**
 * 类型化上游错误（借鉴 all-api-hub 的封闭错误码联合）：
 * 服务层抛 UpstreamError 携带机器可读 code，路由层按 code 映射 HTTP 状态，
 * 不再依赖 err.message.includes(...) 的字符串匹配。
 */

export type UpstreamErrorCode =
  | 'provider_not_found'
  | 'invalid_upstream_type'
  | 'balance_unsupported'
  | 'upstream_timeout'
  | 'upstream_auth_error'
  | 'upstream_rate_limited'
  | 'upstream_error'
  | 'outbound_url_invalid'

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode
  /** 上游返回的 HTTP 状态码（网络错误时为 null） */
  readonly upstreamStatus: number | null

  constructor(code: UpstreamErrorCode, message: string, upstreamStatus: number | null = null) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.upstreamStatus = upstreamStatus
  }
}

/** 错误码 → 管理 API 的 HTTP 状态映射 */
export function httpStatusForUpstreamError(code: UpstreamErrorCode): number {
  switch (code) {
    case 'provider_not_found': return 404
    case 'invalid_upstream_type':
    case 'balance_unsupported':
    case 'outbound_url_invalid': return 400
    case 'upstream_timeout': return 504
    case 'upstream_auth_error':
    case 'upstream_rate_limited':
    case 'upstream_error': return 502
  }
}
