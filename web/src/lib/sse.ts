export type ChatProtocol = 'openai' | 'anthropic'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function extractDelta(payload: string, protocol: ChatProtocol): string | null {
  if (!payload || payload === '[DONE]') return null

  try {
    const message = asObject(JSON.parse(payload))
    if (!message) return null

    if (protocol === 'openai') {
      const choices = Array.isArray(message.choices) ? message.choices[0] : null
      const delta = asObject(asObject(choices)?.delta)
      return typeof delta?.content === 'string' ? delta.content : null
    }

    const delta = asObject(message.delta)
    return message.type === 'content_block_delta' && typeof delta?.text === 'string'
      ? delta.text
      : null
  } catch {
    return null
  }
}

function parseEvent(event: string, protocol: ChatProtocol): string | null {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')

  return extractDelta(data, protocol)
}

/** Incrementally parses SSE event boundaries without assuming network chunk boundaries. */
export class SseDeltaParser {
  private buffer = ''

  constructor(private readonly protocol: ChatProtocol) {}

  push(chunk: string): string[] {
    this.buffer += chunk
    const deltas: string[] = []

    while (true) {
      const boundary = this.buffer.match(/\r?\n\r?\n/)
      if (!boundary || boundary.index === undefined) break

      const event = this.buffer.slice(0, boundary.index)
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length)
      const delta = parseEvent(event, this.protocol)
      if (delta) deltas.push(delta)
    }

    return deltas
  }

  finish(): string[] {
    const event = this.buffer
    this.buffer = ''
    const delta = parseEvent(event, this.protocol)
    return delta ? [delta] : []
  }
}
