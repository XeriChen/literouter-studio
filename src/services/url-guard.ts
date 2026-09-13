/**
 * 出站 URL 安全校验（借鉴 sub2api 的出站探测校验思路）。
 *
 * 取舍说明：LiteRouter 按红线 3 定位为「可信局域网/本机」单用户网关，
 * base_url 只能由管理员本人配置，localhost / 内网地址是核心上游场景，
 * 因此**刻意不封禁私网 IP**；这里防御的是 URL 形状错误与协议混淆
 * （file:、unix:、user:pass@、控制字符注入等），在出站请求前做最后一道兜底。
 */

const BLOCKED_PROTOCOLS = new Set(['http:', 'https:'])

export class OutboundUrlError extends Error {
  readonly code: string
  constructor(message: string, code = 'outbound_url_invalid') {
    super(message)
    this.name = 'OutboundUrlError'
    this.code = code
  }
}

/** 校验即将真实出站的完整 URL；不合法时抛 OutboundUrlError。 */
export function assertSafeOutboundUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OutboundUrlError(`invalid outbound url: ${JSON.stringify(truncate(raw))}`)
  }
  if (!BLOCKED_PROTOCOLS.has(url.protocol)) {
    throw new OutboundUrlError(`outbound url must be http(s), got ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new OutboundUrlError('outbound url must not contain credentials (user:pass@)')
  }
  if (!url.hostname || /[\u0000-\u001f\u007f\s]/.test(url.hostname)) {
    throw new OutboundUrlError('outbound url contains control characters or empty host')
  }
  return url
}

function truncate(value: string, max = 80): string {
  return value.length > max ? value.slice(0, max) + '…' : value
}
