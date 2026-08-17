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
