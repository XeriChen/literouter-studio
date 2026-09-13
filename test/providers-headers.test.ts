import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProviderHeaders, parseAuth } from '../src/providers/headers'
import type { ProviderRow } from '../src/types'

function makeProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'test-id',
    name: 'test',
    protocol: 'openai',
    group_id: null,
    base_url: 'https://api.test.com',
    auth_json: '{"api_key":"test-key"}',
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
    enabled: 1,
    upstream_type: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('parseAuth', () => {
  test('parses basic auth_json', () => {
    const provider = makeProvider({ auth_json: '{"api_key":"my-key","version":"2023-06-01"}' })
    const auth = parseAuth(provider)
    assert.equal(auth.api_key, 'my-key')
    assert.equal(auth.version, '2023-06-01')
    assert.equal(auth.custom_auth, undefined)
  })

  test('parses custom_auth config', () => {
    const provider = makeProvider({
      auth_json: JSON.stringify({
        api_key: 'test-key',
        custom_auth: { header_name: 'X-API-Key', format: '{key}' },
      }),
    })
    const auth = parseAuth(provider)
    assert.equal(auth.api_key, 'test-key')
    assert.deepEqual(auth.custom_auth, { header_name: 'X-API-Key', format: '{key}' })
  })

  test('returns empty object for invalid JSON', () => {
    const provider = makeProvider({ auth_json: 'not-json' })
    const auth = parseAuth(provider)
    assert.deepEqual(auth, {})
  })

  test('ignores malformed custom_auth', () => {
    const provider = makeProvider({
      auth_json: JSON.stringify({ api_key: 'key', custom_auth: 'invalid' }),
    })
    const auth = parseAuth(provider)
    assert.equal(auth.api_key, 'key')
    assert.equal(auth.custom_auth, undefined)
  })
})

describe('buildProviderHeaders - default behavior', () => {
  test('OpenAI protocol uses Authorization Bearer', () => {
    const provider = makeProvider({ protocol: 'openai', auth_json: '{"api_key":"test-key"}' })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['authorization'], 'Bearer test-key')
    assert.equal(headers['anthropic-version'], undefined)
  })

  test('Anthropic protocol uses x-api-key', () => {
    const provider = makeProvider({
      protocol: 'anthropic',
      auth_json: '{"api_key":"test-key","version":"2024-01-01"}',
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['x-api-key'], 'test-key')
    assert.equal(headers['anthropic-version'], '2024-01-01')
  })

  test('Anthropic defaults version when missing', () => {
    const provider = makeProvider({ protocol: 'anthropic', auth_json: '{"api_key":"key"}' })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['anthropic-version'], '2023-06-01')
  })
})

describe('buildProviderHeaders - custom auth', () => {
  test('uses custom header name and format', () => {
    const provider = makeProvider({
      protocol: 'openai',
      auth_json: JSON.stringify({
        api_key: 'my-secret',
        custom_auth: { header_name: 'X-API-Key', format: '{key}' },
      }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['X-API-Key'], 'my-secret')
    assert.equal(headers['authorization'], undefined)
  })

  test('replaces {key} placeholder in format', () => {
    const provider = makeProvider({
      protocol: 'openai',
      auth_json: JSON.stringify({
        api_key: 'token123',
        custom_auth: { header_name: 'API-Token', format: 'Token {key}' },
      }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['API-Token'], 'Token token123')
  })

  test('handles multiple {key} occurrences', () => {
    const provider = makeProvider({
      protocol: 'openai',
      auth_json: JSON.stringify({
        api_key: 'abc',
        custom_auth: { header_name: 'X-Auth', format: '{key}-{key}' },
      }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['X-Auth'], 'abc-abc')
  })

  test('Anthropic with custom auth still includes anthropic-version', () => {
    const provider = makeProvider({
      protocol: 'anthropic',
      auth_json: JSON.stringify({
        api_key: 'key',
        version: '2024-01-01',
        custom_auth: { header_name: 'Custom-Key', format: '{key}' },
      }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['Custom-Key'], 'key')
    assert.equal(headers['anthropic-version'], '2024-01-01')
    assert.equal(headers['x-api-key'], undefined)
  })

  test('ignores custom_auth when api_key missing', () => {
    const provider = makeProvider({
      protocol: 'openai',
      auth_json: JSON.stringify({
        custom_auth: { header_name: 'X-Key', format: '{key}' },
      }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['X-Key'], undefined)
  })

  test('trims header_name whitespace', () => {
    const provider = makeProvider({
      protocol: 'openai',
      auth_json: JSON.stringify({
        api_key: 'key',
        custom_auth: { header_name: '  X-API-Key  ', format: '{key}' },
      }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['X-API-Key'], 'key')
    assert.equal(headers['  X-API-Key  '], undefined)
  })
})

describe('buildProviderHeaders - custom_headers interaction', () => {
  test('custom_headers cannot override custom auth header', () => {
    const provider = makeProvider({
      protocol: 'openai',
      auth_json: JSON.stringify({
        api_key: 'real-key',
        custom_auth: { header_name: 'X-API-Key', format: '{key}' },
      }),
      custom_headers_json: JSON.stringify({ 'X-API-Key': 'fake-key', 'X-Other': 'value' }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['X-API-Key'], 'real-key')
    assert.equal(headers['X-Other'], 'value')
  })

  test('custom_headers cannot override accept-encoding', () => {
    const provider = makeProvider({
      protocol: 'openai',
      auth_json: '{"api_key":"key"}',
      custom_headers_json: JSON.stringify({ 'accept-encoding': 'gzip' }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['accept-encoding'], undefined)
  })

  test('custom_headers case-insensitive blocking', () => {
    const provider = makeProvider({
      protocol: 'openai',
      auth_json: JSON.stringify({
        api_key: 'key',
        custom_auth: { header_name: 'X-Auth', format: '{key}' },
      }),
      custom_headers_json: JSON.stringify({ 'x-auth': 'blocked', 'X-AUTH': 'blocked2' }),
    })
    const headers = buildProviderHeaders(provider)
    assert.equal(headers['X-Auth'], 'key')
    assert.equal(headers['x-auth'], undefined)
    assert.equal(headers['X-AUTH'], undefined)
  })
})
