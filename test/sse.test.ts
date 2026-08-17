import assert from 'node:assert/strict'
import test from 'node:test'
import { SseDeltaParser } from '../web/src/lib/sse'

test('parses OpenAI SSE events split across arbitrary chunks', () => {
  const parser = new SseDeltaParser('openai')

  assert.deepEqual(parser.push('data: {"choices":[{"delta":{"content":"Hel'), [])
  assert.deepEqual(parser.push('lo"}}]}\n\n'), ['Hello'])
  assert.deepEqual(parser.push('data: [DONE]\n\n'), [])
  assert.deepEqual(parser.finish(), [])
})

test('parses Anthropic CRLF events and ignores non-data lines', () => {
  const parser = new SseDeltaParser('anthropic')
  const event = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta",',
    'data: "delta":{"text":"你好"}}',
    '',
    '',
  ].join('\r\n')

  assert.deepEqual(parser.push(event), ['你好'])
})

test('flushes a final event without a trailing blank line', () => {
  const parser = new SseDeltaParser('openai')
  parser.push('data: {"choices":[{"delta":{"content":"final"}}]}')

  assert.deepEqual(parser.finish(), ['final'])
})
