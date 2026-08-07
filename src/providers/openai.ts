import type { ProviderRow } from '../types'
import { parseAuth } from './headers'

export interface ChatRequestInput {
  model: string
  prompt: string
}

/** 构造 OpenAI 非流式 Chat 请求体（测活用） */
export function buildOpenAIChatBody(input: ChatRequestInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: [{ role: 'user', content: input.prompt }],
    stream: false,
  }
}

export function buildOpenAIModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/models`
}

export function extractOpenAIReply(body: unknown): string {
  const choices = (body as { choices?: { message?: { content?: string } }[] })?.choices
  return choices?.[0]?.message?.content ?? ''
}

export function openaiAuthHeaders(auth: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {}
  if (auth.api_key) h['authorization'] = `Bearer ${auth.api_key}`
  return h
}

export function getOpenAIAuth(provider: ProviderRow): Record<string, string> {
  return openaiAuthHeaders(parseAuth(provider))
}