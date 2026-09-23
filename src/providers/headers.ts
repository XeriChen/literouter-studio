import { decrypt } from '../crypto'
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

export interface CustomAuthConfig {
  header_name: string
  format: string
}

export interface ParsedAuth {
  api_key?: string
  access_token?: string
  version?: string
  custom_auth?: CustomAuthConfig
  [key: string]: string | CustomAuthConfig | undefined
}

export function parseAuth(provider: ProviderRow): ParsedAuth {
  try {
    const parsed = JSON.parse(provider.auth_json) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const obj = parsed as Record<string, unknown>
    const result: ParsedAuth = {}
    if (typeof obj.access_token === 'string') result.access_token = obj.access_token
    if (typeof obj.api_key === 'string') result.api_key = obj.api_key
    if (typeof obj.version === 'string') result.version = obj.version
    if (obj.custom_auth && typeof obj.custom_auth === 'object' && !Array.isArray(obj.custom_auth)) {
      const ca = obj.custom_auth as Record<string, unknown>
      if (typeof ca.header_name === 'string' && typeof ca.format === 'string') {
        result.custom_auth = { header_name: ca.header_name, format: ca.format }
      }
    }
    return result
  } catch {
    return {}
  }
}

export function parseCustomHeaders(provider: ProviderRow): Record<string, string> {
  return parseStringRecord(provider.custom_headers_json || '{}')
}

/** 认证数据落库形态：加密列为密文，明文列仅在迁移期或未加密时才有内容 */
export interface ProviderAuthRow {
  id?: string
  name?: string
  auth_json: string
  auth_json_encrypted?: string | null
}

/**
 * 解密 Provider 认证数据：优先使用加密列，回退明文列（迁移期兼容）。
 * 解密失败直接抛错——代理转发/构建上游头/备份导出均不得静默回退空凭据，
 * 否则会用空认证出站，或产出「看起来完整、实际丢了所有密钥」的备份。
 * 读取路径统一走本助手，由调用方决定错误语义（代理 502 / 备份 backup_export_failed）。
 */
export function decryptAuthJson(row: ProviderAuthRow): string {
  if (!row.auth_json_encrypted) return row.auth_json
  try {
    return decrypt(row.auth_json_encrypted)
  } catch (err) {
    const label = row.name ? `${row.name} (${row.id})` : row.id
    const context = label ? ` for ${label}` : ''
    throw new Error(`failed to decrypt auth_json${context}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

/** 由 Provider 配置构造上游请求头（认证 + anthropic-version + 自定义头） */
export function buildProviderHeaders(provider: ProviderRow, customOverride?: Record<string, string>): Record<string, string> {
  const auth = parseAuth(provider)
  const custom = customOverride ?? parseCustomHeaders(provider)
  const headers: Record<string, string> = {}

  // 优先使用自定义认证头配置
  const apiKey = auth.api_key
  if (auth.custom_auth?.header_name && auth.custom_auth?.format && apiKey) {
    const headerName = auth.custom_auth.header_name.trim()
    // 回调替换：避免 String.replace 把 api_key 中的 $& / $` / $' / $n 当成特殊替换模式
    const value = auth.custom_auth.format.replace(/\{key\}/g, () => apiKey)
    headers[headerName] = value
    // Anthropic 协议仍需 anthropic-version
    if (provider.protocol === 'anthropic') {
      headers['anthropic-version'] = auth.version || '2023-06-01'
    }
  } else {
    // 回退到协议默认行为
    if (provider.protocol === 'openai') {
      if (auth.api_key) headers['authorization'] = `Bearer ${auth.api_key}`
    } else {
      if (auth.api_key) headers['x-api-key'] = auth.api_key
      headers['anthropic-version'] = auth.version || '2023-06-01'
    }
  }

  // custom_headers 不能覆盖已设置的认证头和保留头
  const reservedLower = new Set(Object.keys(headers).map(k => k.toLowerCase()))
  reservedLower.add('accept-encoding')

  for (const [k, v] of Object.entries(custom)) {
    if (reservedLower.has(k.toLowerCase())) continue
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
