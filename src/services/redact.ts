/**
 * 敏感键识别与文本脱敏（借鉴 all-api-hub 的 isSensitiveHeuristicKey）。
 * 用于错误信息与审计日志写入前，避免把上游回显的密钥/Token 落进日志。
 */

const SENSITIVE_KEY_PATTERN = /authorization|cookie|token|api[-_]?key|apikey|secret|password|session[-_]?id/i

/** 形如 sk-xxxx / Bearer xxx / 长十六进制串的裸密钥 */
const BARE_SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-[A-Za-z0-9_-]{8,}/g, replacement: 'sk-***' },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, replacement: 'Bearer ***' },
]

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

/** 深拷贝并对敏感键的值打码；用于把 auth/headers 对象写入日志前的兜底处理 */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 8) return '***'
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? '***' : redactObject(item, depth + 1)
    }
    return output
  }
  return value
}

/** 文本脱敏：命中敏感键的 key=value / key: value 片段与裸密钥模式都打码 */
export function redactText(text: string): string {
  let output = text
  for (const { pattern, replacement } of BARE_SECRET_PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  output = output.replace(
    new RegExp(`(${SENSITIVE_KEY_PATTERN.source})\\s*[=:"]\\s*["']?([A-Za-z0-9._-]{8,})`, 'gi'),
    (_match, key: string) => `${key}=***`,
  )
  return output
}
