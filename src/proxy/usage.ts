/**
 * 被动 usage 解析器：仅从客户端本就会收到的响应字节中提取 token 用量，
 * 绝不向任何请求注入字段（红线 2）。精度边界见 ARCHITECTURE.md §8：
 * - Anthropic：message_start / message_delta 自带 usage，非流式响应自带 usage
 * - OpenAI：非流式自带 usage；流式仅在客户端自行开启 stream_options.include_usage 时可见
 *
 * 实现说明：只扫描「未转义的 JSON 键」。字符串值内的引号在 JSON/SSE 序列化时必然被转义为 \"，
 * 因此裸露的 `"input_tokens":` 只会出现在真实 usage 键上，不会被模型输出内容误触发。
 * 同一键取最后一次出现（对齐 Anthropic message_delta 的累计值语义与 JSON 后者生效语义）。
 * 跨 chunk 用 64 字节尾缓冲衔接（最长键约 30 字节）。
 */

const CARRY_BYTES = 64

const PROMPT_KEYS = ['"prompt_tokens":', '"input_tokens":']
const CACHE_READ_KEY = '"cache_read_input_tokens":'
const CACHE_CREATION_KEY = '"cache_creation_input_tokens":'
const COMPLETION_KEYS = ['"completion_tokens":', '"output_tokens":']
const TOTAL_KEY = '"total_tokens":'

export interface UsageSnapshot {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface UsageParser {
  feed(chunk: Uint8Array): void
  snapshot(): UsageSnapshot | null
}

function lastNumberAfter(text: string, keys: string[]): number | null {
  let bestIndex = -1
  let bestValue: number | null = null
  for (const key of keys) {
    let index = text.lastIndexOf(key)
    while (index !== -1) {
      // 从键结尾的冒号起锚定匹配，避免命中切片内后续无关键值
      const match = /^:\s*(\d+)/.exec(text.slice(index + key.length - 1, index + key.length + 24))
      if (match) {
        if (index > bestIndex) {
          bestIndex = index
          bestValue = Number(match[1])
        }
        break
      }
      index = text.lastIndexOf(key, index - 1)
    }
  }
  return bestValue
}

export function createUsageParser(): UsageParser {
  let carry = ''
  let promptRaw: number | null = null
  let cacheRead: number | null = null
  let cacheCreation: number | null = null
  let completionRaw: number | null = null
  let totalRaw: number | null = null

  return {
    feed(chunk: Uint8Array) {
      if (chunk.byteLength === 0) return
      // latin1 保证字节与字符一一对应：ASCII 键完整保留，多字节 UTF-8 序列只表现为
      // 无关字符，不会伪造 ASCII 键形状
      const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1')
      const combined = carry + text
      const foundPrompt = lastNumberAfter(combined, PROMPT_KEYS)
      const foundCacheRead = lastNumberAfter(combined, [CACHE_READ_KEY])
      const foundCacheCreation = lastNumberAfter(combined, [CACHE_CREATION_KEY])
      const foundCompletion = lastNumberAfter(combined, COMPLETION_KEYS)
      const foundTotal = lastNumberAfter(combined, [TOTAL_KEY])
      if (foundPrompt !== null) promptRaw = foundPrompt
      if (foundCacheRead !== null) cacheRead = foundCacheRead
      if (foundCacheCreation !== null) cacheCreation = foundCacheCreation
      if (foundCompletion !== null) completionRaw = foundCompletion
      if (foundTotal !== null) totalRaw = foundTotal
      carry = combined.length > CARRY_BYTES ? combined.slice(-CARRY_BYTES) : combined
    },
    snapshot(): UsageSnapshot | null {
      if (promptRaw === null && completionRaw === null) return null
      const prompt = (promptRaw ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0)
      const completion = completionRaw ?? 0
      return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: totalRaw ?? prompt + completion,
      }
    },
  }
}
