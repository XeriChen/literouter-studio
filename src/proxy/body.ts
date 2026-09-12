const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()
const EMPTY_BYTES = new Uint8Array(0)

/** Maximum request size accepted by both proxy and management endpoints. */
export const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024

/**
 * 上游 /models 响应体的累积上限。原本这段代码会把整个响应体无界地 push 进内存数组
 * 直到 timeout 兜底才中止——是代码层面唯一的无限累积点。这里加硬上限，超限即抛错，
 * 避免上游返回异常超大 body 时撑爆网关内存。
 */
export const MAX_UPSTREAM_MODELS_BODY_BYTES = 50 * 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body too large (max ${maxBytes} bytes)`)
    this.name = 'RequestBodyTooLargeError'
  }
}

export interface ParsedProxyBody {
  model: string
  /**
   * 原始请求体字节。所有区间都是该缓冲区内的 UTF-8 字节偏移（而非字符串下标），
   * 这样改写时无需保留整份解码后的字符串，等待上游期间的内存占用约为 body 的 1 倍。
   * 改写完成后可调用 releaseProxyBody 释放该引用。
   */
  bytes: Uint8Array
  modelValueStart: number
  modelValueEnd: number
  /** 顶层对象开括号 `{` 之后的字节偏移，用于注入新顶层字段 */
  contentStart: number
  /** 顶层 thinking / reasoning_effort 最后一次出现的值区间（重复键沿用 JSON.parse 最后生效语义） */
  extraRanges: Partial<Record<'thinking' | 'reasoning_effort', { valueStart: number; valueEnd: number }>>
}

/**
 * 按映射配置改写思考等级字段（协议原生值）：
 * - override：字段已存在则替换其值，否则在对象开头注入
 * - default：仅在字段不存在时注入
 */
export interface ThinkingRewrite {
  key: 'thinking' | 'reasoning_effort'
  mode: 'override' | 'default'
  value: unknown
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (index < source.length && /\s/.test(source[index]!)) index++
  return index
}

function stringEnd(source: string, start: number): number {
  if (source[start] !== '"') throw new SyntaxError('expected JSON string')
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') {
      index++
      continue
    }
    if (source[index] === '"') return index + 1
  }
  throw new SyntaxError('unterminated JSON string')
}

function compositeEnd(source: string, start: number): number {
  const stack = [source[start]!]
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]!
    if (char === '"') {
      index = stringEnd(source, index) - 1
      continue
    }
    if (char === '{' || char === '[') {
      stack.push(char)
      continue
    }
    if (char === '}' || char === ']') {
      const opener = stack.pop()
      if ((opener === '{' && char !== '}') || (opener === '[' && char !== ']')) {
        throw new SyntaxError('mismatched JSON delimiter')
      }
      if (stack.length === 0) return index + 1
    }
  }
  throw new SyntaxError('unterminated JSON value')
}

function valueEnd(source: string, start: number): number {
  const char = source[start]
  if (char === '"') return stringEnd(source, start)
  if (char === '{' || char === '[') return compositeEnd(source, start)

  let end = start
  while (end < source.length && source[end] !== ',' && source[end] !== '}') end++
  while (end > start && /\s/.test(source[end - 1]!)) end--
  return end
}

/**
 * 把解码后字符串下标换算成原始字节偏移。请求体含非 ASCII 时下标与字节位置不同，
 * 必须按 UTF-8 长度累计（并正确处理代理对与 BOM）。所需下标一次升序扫描完成，避免重复遍历整份 body。
 */
function charToByteOffsets(source: string, indices: number[], base: number): number[] {
  const unique = Array.from(new Set(indices)).sort((a, b) => a - b)
  const offsets = new Map<number, number>()
  let byte = base
  let cursor = 0
  for (const index of unique) {
    while (cursor < index) {
      const code = source.charCodeAt(cursor)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = source.charCodeAt(cursor + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          byte += 4
          cursor += 2
          continue
        }
      }
      byte += code < 0x80 ? 1 : code < 0x800 ? 2 : 3
      cursor++
    }
    offsets.set(index, byte)
  }
  return indices.map((index) => offsets.get(index)!)
}

/**
 * Parses a proxy request while retaining the exact byte ranges of the top-level
 * `model` value (and optional thinking fields). Replacing those ranges avoids
 * reserializing or otherwise changing unrelated request fields, and keeps the
 * held representation to a single copy of the raw body instead of a decoded string.
 */
export function parseProxyBody(body: Uint8Array): ParsedProxyBody | null {
  let source: string
  let parsed: unknown
  try {
    source = decoder.decode(body)
    parsed = JSON.parse(source) as unknown
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const parsedModel = (parsed as Record<string, unknown>).model
  if (typeof parsedModel !== 'string' || !parsedModel) return null

  try {
    let index = skipWhitespace(source, 0)
    if (source[index] !== '{') return null
    index++
    const contentStart = index

    let match: { model: string; modelValueStart: number; modelValueEnd: number } | null = null
    const charRanges: ParsedProxyBody['extraRanges'] = {}
    while (true) {
      index = skipWhitespace(source, index)
      if (source[index] === '}') break

      const keyStart = index
      const keyEnd = stringEnd(source, keyStart)
      const key = JSON.parse(source.slice(keyStart, keyEnd)) as unknown
      index = skipWhitespace(source, keyEnd)
      if (source[index] !== ':') return null

      const modelValueStart = skipWhitespace(source, index + 1)
      const modelValueEnd = valueEnd(source, modelValueStart)
      if (key === 'model' && source[modelValueStart] === '"') {
        const model = JSON.parse(source.slice(modelValueStart, modelValueEnd)) as unknown
        if (typeof model === 'string') {
          match = { model, modelValueStart, modelValueEnd }
        }
      }
      if (key === 'thinking' || key === 'reasoning_effort') {
        charRanges[key] = { valueStart: modelValueStart, valueEnd: modelValueEnd }
      }

      index = skipWhitespace(source, modelValueEnd)
      if (source[index] === ',') {
        index++
        continue
      }
      if (source[index] === '}') break
      return null
    }

    // JSON.parse uses the final duplicate key, so the located value must match it.
    if (match?.model !== parsedModel) return null

    // TextDecoder 默认丢弃前导 UTF-8 BOM；字节偏移需相应平移。
    const base = body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0
    const [modelValueStart, modelValueEnd] = charToByteOffsets(source, [match.modelValueStart, match.modelValueEnd], base)
    const contentByteStart = charToByteOffsets(source, [contentStart], base)[0]!
    const extraRanges: ParsedProxyBody['extraRanges'] = {}
    for (const key of ['thinking', 'reasoning_effort'] as const) {
      const range = charRanges[key]
      if (!range) continue
      const [valueStart, valueEnd] = charToByteOffsets(source, [range.valueStart, range.valueEnd], base)
      extraRanges[key] = { valueStart: valueStart!, valueEnd: valueEnd! }
    }

    return {
      model: match.model,
      bytes: body,
      modelValueStart: modelValueStart!,
      modelValueEnd: modelValueEnd!,
      contentStart: contentByteStart,
      extraRanges,
    }
  } catch {
    return null
  }
}

interface BodyEdit {
  start: number
  end: number
  replacement: Uint8Array
}

/**
 * 按原始字节区间做定点替换/插入：只新建一个输出缓冲区，不生成解码字符串或整份字符串副本。
 * 除被替换的区间外，其余字节原样拷贝，保证不改变非目标字段的任何字节。
 */
function spliceBytes(bytes: Uint8Array, edits: BodyEdit[]): Uint8Array {
  edits.sort((a, b) => a.start - b.start)
  let size = bytes.length
  for (const edit of edits) size += edit.replacement.length - (edit.end - edit.start)

  const output = new Uint8Array(size)
  let position = 0
  let cursor = 0
  for (const edit of edits) {
    const untouched = bytes.subarray(cursor, edit.start)
    output.set(untouched, position)
    position += untouched.length
    output.set(edit.replacement, position)
    position += edit.replacement.length
    cursor = edit.end
  }
  output.set(bytes.subarray(cursor), position)
  return output
}

export function replaceProxyModel(body: ParsedProxyBody, model: string): Uint8Array {
  return spliceBytes(body.bytes, [
    { start: body.modelValueStart, end: body.modelValueEnd, replacement: encoder.encode(JSON.stringify(model)) },
  ])
}

/**
 * model => 真实模型名 + 按映射配置改写思考等级字段，一次扫描完成所有定点编辑。
 * 除 model 与思考字段外严禁改动其他字节。
 */
export function rewriteProxyBody(body: ParsedProxyBody, model: string, thinking: ThinkingRewrite | null): Uint8Array {
  const edits: BodyEdit[] = [
    { start: body.modelValueStart, end: body.modelValueEnd, replacement: encoder.encode(JSON.stringify(model)) },
  ]
  if (thinking) {
    const range = body.extraRanges[thinking.key]
    if (!range || thinking.mode === 'override') {
      const serialized = JSON.stringify(thinking.value)
      edits.push(range
        ? { start: range.valueStart, end: range.valueEnd, replacement: encoder.encode(serialized) }
        : { start: body.contentStart, end: body.contentStart, replacement: encoder.encode(`${JSON.stringify(thinking.key)}:${serialized},`) })
    }
  }
  return spliceBytes(body.bytes, edits)
}

/**
 * 释放解析结果对原始请求体的引用。转发时只需保留改写后的 outBody，
 * 因此在等待上游响应（可能长达数十秒）期间不应继续持有整份原始 body。
 */
export function releaseProxyBody(body: ParsedProxyBody): void {
  body.bytes = EMPTY_BYTES
}

/** Reads a Fetch request body without ever buffering more than maxBytes. */
export async function readRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes)
  }
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestBodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  if (chunks.length === 1) return chunks[0]!
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}
