export interface ChatRequestInput {
  model: string
  prompt: string
}

/** 构造 OpenAI 非流式 Chat 请求体（测活用）；max_tokens 压到上限，控制探测成本 */
export function buildOpenAIChatBody(input: ChatRequestInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: [{ role: 'user', content: input.prompt }],
    stream: false,
    max_tokens: 32,
  }
}

export function buildOpenAIModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/models`
}

export function extractOpenAIReply(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object') return ''
  const message = (first as { message?: unknown }).message
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}
