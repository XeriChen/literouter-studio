/**
 * 代理上游路径 v1 归一化。
 *
 * 客户端可能忘记写 `/v1`（如 `/openai/chat/completions`、`/anthropic/messages`），
 * 也可能写了多重前缀（如 `/openai/v1/v1/chat/completions`）。为保持网关宽容，
 * 这里剔除路径中所有 `v1` 段（忽略大小写）后，再在头部补回恰好一个 `/v1`。
 *
 * 模型名位于请求 body 而非路径，剔除路径中的 `v1` 段不会误伤真实模型名。
 */
export function normalizeUpstreamPath(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '/') return '/v1'

  const segments = trimmed.split('/').filter((tok) => tok !== '')
  const nonVersion = segments.filter((tok) => tok.toLowerCase() !== 'v1')

  if (nonVersion.length === 0) return '/v1'
  return `/v1/${nonVersion.join('/')}`
}