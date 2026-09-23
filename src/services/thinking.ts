import type { ThinkingRewrite } from '../proxy/body'
import type { ProviderProtocol } from '../types'

/**
 * 解析映射上的思考等级配置为请求体改写指令。
 * 配置缺失、JSON 损坏、mode 非法或 value 形状不符合协议时返回 null（按纯透传处理）：
 * 宁可放弃改写，也不把形状错误的原生值注入请求体。
 */
export function parseThinkingRewrite(protocol: ProviderProtocol, thinkingJson: string | null): ThinkingRewrite | null {
  if (!thinkingJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(thinkingJson)
  } catch (err) {
    console.error(`[models] corrupted thinking_json (${protocol}):`, err instanceof Error ? err.message : String(err))
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const config = parsed as Record<string, unknown>
  const mode = config.mode
  if (mode !== 'override' && mode !== 'default') return null
  if (!validateThinkingValue(protocol, config.value)) return null
  return { key: protocol === 'anthropic' ? 'thinking' : 'reasoning_effort', mode, value: config.value }
}

/** 按协议校验思考配置的原生值：anthropic 为 thinking 对象，openai 为 reasoning_effort 字符串。 */
export function validateThinkingValue(protocol: ProviderProtocol, value: unknown): boolean {
  if (protocol === 'openai') return typeof value === 'string' && value.length > 0
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const thinking = value as Record<string, unknown>
  if (thinking.type === 'enabled') return Number.isInteger(thinking.budget_tokens) && (thinking.budget_tokens as number) >= 1024
  return thinking.type === 'disabled'
}
