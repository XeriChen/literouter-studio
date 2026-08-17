const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

/** Maximum request size accepted by both proxy and management endpoints. */
export const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024

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

    let match: Omit<ParsedProxyBody, 'source'> | null = null
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

      index = skipWhitespace(source, modelValueEnd)
      if (source[index] === ',') {
        index++
        continue
      }
      if (source[index] === '}') break
      return null
    }

    // JSON.parse uses the final duplicate key, so the located value must match it.
    return match?.model === parsedModel ? { ...match, source } : null
  } catch {
    return null
  }
}

export function replaceProxyModel(body: ParsedProxyBody, model: string): Uint8Array {
  const output = body.source.slice(0, body.modelValueStart)
    + JSON.stringify(model)
    + body.source.slice(body.modelValueEnd)
  return encoder.encode(output)
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
