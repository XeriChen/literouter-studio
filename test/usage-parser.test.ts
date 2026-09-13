import { test } from 'node:test'
import assert from 'node:assert'
import { createUsageParser } from '../src/proxy/usage'

function feedAll(parser: ReturnType<typeof createUsageParser>, chunks: string[]): void {
  for (const chunk of chunks) parser.feed(new TextEncoder().encode(chunk))
}

test('parses OpenAI non-stream JSON usage', () => {
  const parser = createUsageParser()
  feedAll(parser, [
    '{"id":"x","choices":[{"message":{"content":"hi"}}],',
    '"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150}}',
  ])
  assert.deepStrictEqual(parser.snapshot(), { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 })
})

test('parses Anthropic non-stream usage', () => {
  const parser = createUsageParser()
  feedAll(parser, [
    '{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"hi"}],',
    '"stop_reason":"end_turn","usage":{"input_tokens":2095,"output_tokens":503}}',
  ])
  assert.deepStrictEqual(parser.snapshot(), { prompt_tokens: 2095, completion_tokens: 503, total_tokens: 2598 })
})

test('parses Anthropic SSE with cache tokens (message_start + message_delta, last wins)', () => {
  const parser = createUsageParser()
  feedAll(parser, [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":100,"cache_creation_input_tokens":200,"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\\"input_tokens\\":999 is quoted text"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":25,"cache_read_input_tokens":100,"cache_creation_input_tokens":200,"output_tokens":777}}\n\n',
  ])
  // prompt = input 25 + cache_read 100 + cache_creation 200
  assert.deepStrictEqual(parser.snapshot(), { prompt_tokens: 325, completion_tokens: 777, total_tokens: 1102 })
})

test('OpenAI streaming without usage chunk yields null (client did not request usage)', () => {
  const parser = createUsageParser()
  feedAll(parser, [
    'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n',
    'data: {"id":"c1","choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  assert.strictEqual(parser.snapshot(), null)
})

test('OpenAI streaming usage chunk when client enabled include_usage', () => {
  const parser = createUsageParser()
  feedAll(parser, [
    'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
    'data: [DONE]\n\n',
  ])
  assert.deepStrictEqual(parser.snapshot(), { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })
})

test('keys split across chunk boundaries are still detected', () => {
  const parser = createUsageParser()
  const full = '{"usage":{"prompt_tokens":42,"completion_tokens":8}}'
  // 逐字节喂入，最坏切分情况
  const chunks: string[] = []
  for (let i = 0; i < full.length; i += 3) chunks.push(full.slice(i, i + 3))
  feedAll(parser, chunks)
  assert.deepStrictEqual(parser.snapshot(), { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 })
})

test('model output containing quoted token-like text does not poison the count', () => {
  const parser = createUsageParser()
  feedAll(parser, [
    '{"choices":[{"message":{"content":"the log said \\"input_tokens\\":12345 which is escaped"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
  ])
  assert.deepStrictEqual(parser.snapshot(), { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
})

test('returns null for responses without usage', () => {
  const parser = createUsageParser()
  feedAll(parser, ['{"error":{"message":"boom"}}'])
  assert.strictEqual(parser.snapshot(), null)
})

test('multi-byte UTF-8 content does not break ascii key detection', () => {
  const parser = createUsageParser()
  feedAll(parser, ['{"choices":[{"message":{"content":"你好，世界 🌍 こんにちは"}}],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}'])
  assert.deepStrictEqual(parser.snapshot(), { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 })
})
