import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUpstreamHeaders, buildUpstreamUrl } from '../src/providers/headers'
import type { ProviderRow } from '../src/types'

const provider: ProviderRow = {
  id: 'provider-id',
  name: 'Test Provider',
  protocol: 'openai',
  group_id: null,
  base_url: 'https://upstream.example/',
  auth_json: JSON.stringify({ api_key: 'upstream-key' }),
  custom_headers_json: JSON.stringify({
    authorization: 'must-not-win',
    'accept-encoding': 'gzip',
    'x-provider-trace': 'enabled',
  }),
  proxy_url: null,
  timeout_ms: null,
  model_filter: null,
  enabled: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

test('buildUpstreamHeaders protects gateway credentials and SSE compression semantics', () => {
  const headers = buildUpstreamHeaders(
    provider,
    new Headers({
      authorization: 'Bearer gateway-token',
      'x-api-key': 'gateway-token',
      'accept-encoding': 'br, gzip',
      'content-length': '999',
      'x-request-id': 'request-id',
    }),
  )

  assert.equal(headers.authorization, 'Bearer upstream-key')
  assert.equal(headers['accept-encoding'], 'identity')
  assert.equal(headers['x-api-key'], undefined)
  assert.equal(headers['content-length'], undefined)
  assert.equal(headers['x-request-id'], 'request-id')
  assert.equal(headers['x-provider-trace'], 'enabled')
})

test('buildUpstreamUrl preserves query strings and removes duplicate base URL slashes', () => {
  assert.equal(
    buildUpstreamUrl('https://upstream.example///', '/v1/chat/completions', '?stream=true'),
    'https://upstream.example/v1/chat/completions?stream=true',
  )
})
