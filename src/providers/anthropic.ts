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
  if (!body || typeof body !== 'object') return ''
  const content = (body as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}
