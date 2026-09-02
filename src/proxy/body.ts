const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

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
  source: string
  modelValueStart: number
  modelValueEnd: number
  /** 顶层对象开括号 `{` 之后的位置，用于注入新顶层字段 */
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
 * Parses a proxy request while retaining the exact source range of the top-level
 * `model` value. Replacing that range avoids reserializing or otherwise changing
 * unrelated request fields.
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
    const extraRanges: ParsedProxyBody['extraRanges'] = {}
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
        extraRanges[key] = { valueStart: modelValueStart, valueEnd: modelValueEnd }
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
    return match?.model === parsedModel ? { ...match, source, contentStart, extraRanges } : null
  } catch {
    return null
  }
}

interface BodyEdit {
  start: number
  end: number
  replacement: string
}

/** 按原文区间做定点替换/插入，不重新序列化 JSON，其余字节原样保留。 */
function applyEdits(source: string, edits: BodyEdit[]): Uint8Array {
  edits.sort((a, b) => a.start - b.start)
  let output = ''
  let position = 0
  for (const edit of edits) {
    output += source.slice(position, edit.start) + edit.replacement
    position = edit.end
  }
  output += source.slice(position)
  return encoder.encode(output)
}

export function replaceProxyModel(body: ParsedProxyBody, model: string): Uint8Array {
  return applyEdits(body.source, [
    { start: body.modelValueStart, end: body.modelValueEnd, replacement: JSON.stringify(model) },
  ])
}

/**
 * model => 真实模型名 + 按映射配置改写思考等级字段，一次扫描完成所有定点编辑。
 * 除 model 与思考字段外严禁改动其他字节。
 */
export function rewriteProxyBody(body: ParsedProxyBody, model: string, thinking: ThinkingRewrite | null): Uint8Array {
  const edits: BodyEdit[] = [
    { start: body.modelValueStart, end: body.modelValueEnd, replacement: JSON.stringify(model) },
  ]
  if (thinking) {
    const range = body.extraRanges[thinking.key]
    if (!range || thinking.mode === 'override') {
      const serialized = JSON.stringify(thinking.value)
      edits.push(range
        ? { start: range.valueStart, end: range.valueEnd, replacement: serialized }
        : { start: body.contentStart, end: body.contentStart, replacement: `${JSON.stringify(thinking.key)}:${serialized},` })
    }
  }
  return applyEdits(body.source, edits)
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
