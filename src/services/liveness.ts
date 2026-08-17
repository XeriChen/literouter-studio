import { drainBody, getDispatcher, sendToUpstream, isTimeoutError } from '../proxy'
import { buildAnthropicChatBody, extractAnthropicReply } from '../providers/anthropic'
import { buildOpenAIChatBody, extractOpenAIReply } from '../providers/openai'
import { buildProviderHeaders } from '../providers/headers'
import { getProvider } from './providers'
import type { ProviderRow } from '../types'

const LIVENESS_TIMEOUT_MS = 30_000

const BLACKLISTED_PROMPTS = new Set(['hi', 'hello', '你好', '测试', 'test', '1'])

export function validateTestPrompt(prompt: string): string | null {
  const trimmed = prompt.trim()
  if (BLACKLISTED_PROMPTS.has(trimmed.toLowerCase())) return '请使用更具实质内容的提示词进行测试'
  if (trimmed.length < 4) return '提示词过短，至少 4 个字符'
  return null
}

function buildChatBody(provider: ProviderRow, modelId: string, prompt: string): Record<string, unknown> {
  return provider.protocol === 'openai'
    ? buildOpenAIChatBody({ model: modelId, prompt })
    : buildAnthropicChatBody({ model: modelId, prompt })
}

function extractReply(provider: ProviderRow, body: unknown): string {
  return provider.protocol === 'openai' ? extractOpenAIReply(body) : extractAnthropicReply(body)
}

/** 模型测活：构造非流式 Chat 请求，30s 硬超时，同步返回回复 */
export async function testModelLiveness(input: {
  provider_id: string
  model_id: string
  prompt: string
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
    body: new TextEncoder().encode(JSON.stringify(buildChatBody(provider, input.model_id, input.prompt))),
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
