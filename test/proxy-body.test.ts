import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseProxyBody,
  readRequestBody,
  releaseProxyBody,
  replaceProxyModel,
  rewriteProxyBody,
  RequestBodyTooLargeError,
  type ThinkingRewrite,
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

const anthropicThinking: ThinkingRewrite = { key: 'thinking', mode: 'override', value: { type: 'enabled', budget_tokens: 2048 } }
const openaiThinking = (mode: 'override' | 'default'): ThinkingRewrite => ({ key: 'reasoning_effort', mode, value: 'high' })

test('override thinking replaces an existing top-level field value', () => {
  const source = '{"model":"a","thinking":{"type":"enabled","budget_tokens":1},"max_tokens":1024}'
  const body = parseProxyBody(encode(source))!

  assert.equal(
    decode(rewriteProxyBody(body, 'real', anthropicThinking)),
    '{"model":"real","thinking":{"type":"enabled","budget_tokens":2048},"max_tokens":1024}',
  )
})

test('override thinking injects the field when the client omitted it', () => {
  const body = parseProxyBody(encode('{ "model" : "a", "messages":[] }'))!

  assert.equal(
    decode(rewriteProxyBody(body, 'real', anthropicThinking)),
    '{"thinking":{"type":"enabled","budget_tokens":2048}, "model" : "real", "messages":[] }',
  )
})

test('default thinking leaves the client-provided field untouched', () => {
  const source = '{"model":"a","reasoning_effort":"low"}'
  const body = parseProxyBody(encode(source))!

  assert.equal(
    decode(rewriteProxyBody(body, 'real', openaiThinking('default'))),
    '{"model":"real","reasoning_effort":"low"}',
  )
})

test('default thinking injects when missing; override replaces the last duplicate key', () => {
  const injected = rewriteProxyBody(parseProxyBody(encode('{"model":"a"}'))!, 'real', openaiThinking('default'))
  assert.equal(decode(injected), '{"reasoning_effort":"high","model":"real"}')

  const overridden = rewriteProxyBody(
    parseProxyBody(encode('{"reasoning_effort":"low","model":"a","reasoning_effort":"medium"}'))!,
    'real',
    openaiThinking('override'),
  )
  assert.equal(decode(overridden), '{"reasoning_effort":"low","model":"real","reasoning_effort":"high"}')
})

test('without thinking config, rewrite equals a plain model replacement', () => {
  const body = parseProxyBody(encode('{"model":"a","thinking":null}'))!

  assert.equal(decode(rewriteProxyBody(body, 'real', null)), '{"model":"real","thinking":null}')
})

test('byte splice is exact when non-ASCII content precedes the model field', () => {
  const source = '{"messages":[{"role":"user","content":"你好，世界！这是一段中文测试"}],"model":"alias"}'
  const body = parseProxyBody(encode(source))!

  assert.equal(
    decode(replaceProxyModel(body, 'real')),
    '{"messages":[{"role":"user","content":"你好，世界！这是一段中文测试"}],"model":"real"}',
  )
})

test('byte splice handles surrogate pairs (emoji) before the model field', () => {
  const source = '{"note":"😀🎉🚀","model":"alias"}'
  const body = parseProxyBody(encode(source))!

  assert.equal(decode(replaceProxyModel(body, 'real')), '{"note":"😀🎉🚀","model":"real"}')
})

test('thinking injection after non-ASCII content keeps surrounding bytes intact', () => {
  const source = '{"messages":[{"content":"中文内容"}],"model":"a"}'
  const body = parseProxyBody(encode(source))!

  assert.equal(
    decode(rewriteProxyBody(body, 'real', anthropicThinking)),
    '{"thinking":{"type":"enabled","budget_tokens":2048},"messages":[{"content":"中文内容"}],"model":"real"}',
  )
})

test('preserves a leading UTF-8 BOM rather than dropping it', () => {
  const body = parseProxyBody(encode('\uFEFF{"model":"a"}'))!
  const out = replaceProxyModel(body, 'real')

  // 逐字节比较（默认 TextDecoder 会吞掉 BOM，不能用来断言）
  assert.deepEqual(Array.from(out), Array.from(encode('\uFEFF{"model":"real"}')))
})

test('releaseProxyBody drops the retained raw body', () => {
  const body = parseProxyBody(encode('{"model":"a"}'))!
  assert.ok(body.bytes.length > 0)

  releaseProxyBody(body)
  assert.equal(body.bytes.length, 0)
})
