import { drainBody, getDispatcher, sendToUpstream, isTimeoutError } from '../proxy'
import { buildAnthropicChatBody, extractAnthropicReply } from '../providers/anthropic'
import { buildOpenAIChatBody, extractOpenAIReply } from '../providers/openai'
import { buildProviderHeaders } from '../providers/headers'
import { getProvider } from './providers'
import type { ProviderRow, ThinkingConfig } from '../types'

const LIVENESS_TIMEOUT_MS = 30_000

const BLACKLISTED_PROMPTS = new Set(['hi', 'hello', '你好', '测试', 'test', '1'])

export function validateTestPrompt(prompt: string): string | null {
  const trimmed = prompt.trim()
  if (BLACKLISTED_PROMPTS.has(trimmed.toLowerCase())) return '请使用更具实质内容的提示词进行测试'
  if (trimmed.length < 4) return '提示词过短，至少 4 个字符'
  return null
}

function buildChatBody(provider: ProviderRow, modelId: string, prompt: string, thinking: ThinkingConfig | null): Record<string, unknown> {
  const body = provider.protocol === 'openai'
    ? buildOpenAIChatBody({ model: modelId, prompt })
    : buildAnthropicChatBody({ model: modelId, prompt })
  // 测活按映射思考配置注入协议原生字段（mode 是代理侧语义，测活直接携带 value）
  if (thinking) body[provider.protocol === 'anthropic' ? 'thinking' : 'reasoning_effort'] = thinking.value
  return body
}

function extractReply(provider: ProviderRow, body: unknown): string {
  return provider.protocol === 'openai' ? extractOpenAIReply(body) : extractAnthropicReply(body)
}

/** 模型测活：构造非流式 Chat 请求，30s 硬超时，同步返回回复 */
export async function testModelLiveness(input: {
  provider_id: string
  model_id: string
  prompt: string
  /** 可选：映射上配置的思考等级，测活时携带其协议原生 value */
  thinking?: ThinkingConfig | null
}): Promise<{ reply: string; latency_ms: number }> {
  const provider = getProvider(input.provider_id)
  if (!provider) throw new Error('provider not found')

  const startedAt = Date.now()
  const baseUrl = provider.base_url.replace(/\/+$/, '')
  const path = provider.protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages'
  const url = `${baseUrl}${path}`

  const res = await sendToUpstream({
    method: 'POST',
    url,
    headers: {
      ...buildProviderHeaders(provider),
      'accept-encoding': 'identity',
      'content-type': 'application/json',
    },
    body: new TextEncoder().encode(JSON.stringify(buildChatBody(provider, input.model_id, input.prompt, input.thinking ?? null))),
    dispatcher: getDispatcher(provider.proxy_url, LIVENESS_TIMEOUT_MS),
    signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS),
  }).catch((err: unknown) => {
    if (isTimeoutError(err)) throw new Error('upstream_timeout')
    throw err
  })

  try {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`upstream returned HTTP ${res.status}`)
    }
    const json = await new Response(res.body as unknown as BodyInit).json()
    return { reply: extractReply(provider, json), latency_ms: Date.now() - startedAt }
  } finally {
    await drainBody(res.body)
  }
}
