import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeUpstreamPath } from '../src/proxy/path'

test('adds a missing /v1 prefix', () => {
  assert.equal(normalizeUpstreamPath('/chat/completions'), '/v1/chat/completions')
  assert.equal(normalizeUpstreamPath('/messages'), '/v1/messages')
  assert.equal(normalizeUpstreamPath('/models'), '/v1/models')
})

test('keeps a single /v1 prefix unchanged', () => {
  assert.equal(normalizeUpstreamPath('/v1/chat/completions'), '/v1/chat/completions')
  assert.equal(normalizeUpstreamPath('/v1/messages'), '/v1/messages')
  assert.equal(normalizeUpstreamPath('/v1/models'), '/v1/models')
})

test('deduplicates repeated /v1 prefixes', () => {
  assert.equal(normalizeUpstreamPath('/v1/v1/chat/completions'), '/v1/chat/completions')
  assert.equal(normalizeUpstreamPath('/v1/v1/v1/messages'), '/v1/messages')
  assert.equal(normalizeUpstreamPath('/v1/v1/models'), '/v1/models')
})

test('strips mixed-case V1 tokens and collapses anywhere', () => {
  assert.equal(normalizeUpstreamPath('/v1/v1/V1/chat/completions'), '/v1/chat/completions')
  assert.equal(normalizeUpstreamPath('/v1/V1/messages'), '/v1/messages')
})

test('handles boundary inputs', () => {
  assert.equal(normalizeUpstreamPath(''), '/v1')
  assert.equal(normalizeUpstreamPath('/'), '/v1')
  assert.equal(normalizeUpstreamPath('/v1'), '/v1')
  assert.equal(normalizeUpstreamPath('/v1/'), '/v1')
  assert.equal(normalizeUpstreamPath('   /chat/completions  '), '/v1/chat/completions')
})