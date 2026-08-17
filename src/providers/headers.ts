import type { ProviderRow } from '../types'

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
])

export const DROPPED_HEADERS = new Set(['host', 'content-length', 'authorization', 'x-api-key', 'api-key'])

export const RESERVED_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'accept-encoding'])

function parseStringRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

export function parseAuth(provider: ProviderRow): Record<string, string> {
  return parseStringRecord(provider.auth_json)
}

export function parseCustomHeaders(provider: ProviderRow): Record<string, string> {
  return parseStringRecord(provider.custom_headers_json || '{}')
}

/** 由 Provider 配置构造上游请求头（认证 + anthropic-version + 自定义头） */
export function buildProviderHeaders(provider: ProviderRow): Record<string, string> {
  const auth = parseAuth(provider)
  const custom = parseCustomHeaders(provider)
  const headers: Record<string, string> = {}
  if (provider.protocol === 'openai') {
    if (auth.api_key) headers['authorization'] = `Bearer ${auth.api_key}`
  } else {
    if (auth.api_key) headers['x-api-key'] = auth.api_key
    headers['anthropic-version'] = auth.version || '2023-06-01'
  }
  for (const [k, v] of Object.entries(custom)) {
    if (RESERVED_HEADERS.has(k.toLowerCase())) continue
    headers[k] = String(v)
  }
  return headers
}

/** 由客户端请求头 + Provider 配置构造上游请求头（强制 accept-encoding: identity） */
export function buildUpstreamHeaders(provider: ProviderRow, clientHeaders: Headers): Record<string, string> {
  const out = new Headers({ 'accept-encoding': 'identity' })
  clientHeaders.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(k) || DROPPED_HEADERS.has(k)) return
    if (k === 'accept-encoding') return
    out.set(key, value)
  })
  for (const [k, v] of Object.entries(buildProviderHeaders(provider))) {
    out.set(k, v)
  }
  return Object.fromEntries(out.entries())
}

/** 组装上游完整 URL：去除 base_url 尾部 /，保留客户端 query string */
export function buildUpstreamUrl(baseUrl: string, upstreamPath: string, queryString: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const qs = queryString ? (queryString.startsWith('?') ? queryString : `?${queryString}`) : ''
  return `${base}${upstreamPath}${qs}`
}
