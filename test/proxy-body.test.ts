import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseProxyBody,
  readRequestBody,
  replaceProxyModel,
  RequestBodyTooLargeError,
} from '../src/proxy/body'

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

test('replaces only the top-level model string without reserializing JSON', () => {
  const source = ' { "seed": 9007199254740993, "nested": {"model":"keep"}, "model" : "alias", "escaped":"\\u4f60" }\r\n'
  const body = parseProxyBody(encode(source))

  assert.ok(body)
  assert.equal(body.model, 'alias')
  assert.equal(
    decode(replaceProxyModel(body, 'openai/gpt-4')),
    ' { "seed": 9007199254740993, "nested": {"model":"keep"}, "model" : "openai/gpt-4", "escaped":"\\u4f60" }\r\n',
  )
})

test('supports escaped and duplicate model keys using JSON last-key semantics', () => {
  const body = parseProxyBody(encode('{"model":"ignored","mo\\u0064el":"active"}'))

  assert.ok(body)
  assert.equal(body.model, 'active')
  assert.equal(
    decode(replaceProxyModel(body, 'real')),
    '{"model":"ignored","mo\\u0064el":"real"}',
  )
})

test('rejects invalid JSON and non-string model values', () => {
  assert.equal(parseProxyBody(encode('{"model":1}')), null)
  assert.equal(parseProxyBody(encode('{"model":""}')), null)
  assert.equal(parseProxyBody(encode('{"model":"alias"')), null)
})

test('stops reading once the request body exceeds the configured limit', async () => {
  const request = new Request('http://gateway.test/openai/v1/chat/completions', {
    method: 'POST',
    body: '12345',
  })

  await assert.rejects(readRequestBody(request, 4), RequestBodyTooLargeError)
})
