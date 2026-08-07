import type { ProviderRow } from '../types'
import { parseAuth } from './headers'

export interface ChatRequestInput {
  model: string
  prompt: string
}

/** 构造 Anthropic 非流式 Messages 请求体（测活用） */
export function buildAnthropicChatBody(input: ChatRequestInput): Record<string, unknown> {
  return {
    model: input.model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: input.prompt }],
  }
}

export function buildAnthropicModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/models`
}

export function extractAnthropicReply(body: unknown): string {
  const content = (body as { content?: { text?: string }[] })?.content
  return (content ?? []).map((b) => b.text ?? '').join('')
}

export function anthropicAuthHeaders(auth: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'anthropic-version': auth.version || '2023-06-01' }
  if (auth.api_key) h['x-api-key'] = auth.api_key
  return h
}

export function getAnthropicAuth(provider: ProviderRow): Record<string, string> {
  return anthropicAuthHeaders(parseAuth(provider))
}