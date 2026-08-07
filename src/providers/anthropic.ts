export interface BuildHeadersResult {
  headers: Record<string, string>
}

/** 构造 Anthropic 上游请求头（注入 x-api-key 与 anthropic-version） */
export async function buildAnthropicHeaders(
  auth: Record<string, string>,
  customHeaders: Record<string, string>,
): Promise<BuildHeadersResult> {
  // TODO: 注入 x-api-key: <key> 与 anthropic-version: <version>
  // provider 配置的 version 优先级最高，强制覆盖客户端传入值
  return { headers: {} }
}

export function buildAnthropicModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/models`
}