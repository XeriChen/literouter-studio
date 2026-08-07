type Protocol = 'openai' | 'anthropic'

export interface BuildHeadersResult {
  headers: Record<string, string>
}

/** 构造 OpenAI 上游请求头（注入 Authorization: Bearer） */
export async function buildOpenAIHeaders(
  auth: Record<string, string>,
  customHeaders: Record<string, string>,
  _protocol: Protocol,
): Promise<BuildHeadersResult> {
  // TODO: 注入 Authorization: Bearer <token>，合并 custom_headers（严禁覆盖认证头）
  return { headers: {} }
}

export function buildOpenAIModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/models`
}