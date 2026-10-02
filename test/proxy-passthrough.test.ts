import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import type { RoutingConfig } from '../src/services/routing'

const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-proxy-passthrough-'))
process.chdir(tempRoot)

const { db } = await import('../src/db/index')
const providers = await import('../src/services/providers')
const models = await import('../src/services/models')
const { getAdminToken } = await import('../src/services/auth')
const { proxyRoutes } = await import('../src/routes/proxy')
const { isSafeToRetryTransportError } = await import('../src/proxy')
const { getHealthSnapshot } = await import('../src/services/health')

let upstream: Server | undefined
let upstreamPort = 0
/** 最近一次上游收到的请求头：用于验证网关确实带上了 Provider 凭据 */
let seenHeaders: import('node:http').IncomingHttpHeaders | undefined

after(async () => {
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()))
  db.close()
  process.chdir(originalCwd)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      await delay(50)
    }
  }
})

function startUpstream(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const previous = upstream
    upstream = createServer(handler)
    upstream.listen(0, '127.0.0.1', () => {
      if (previous) previous.close()
      resolve((upstream.address() as { port: number }).port)
    })
  })
}

async function setupSingleAlias(baseUrl: string, aliasName: string, routingConfig?: RoutingConfig): Promise<void> {
  const provider = providers.createProvider({
    name: 'passthrough-upstream',
    protocol: 'openai',
    group_id: null,
    base_url: baseUrl,
    auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
  })
  models.addModel({ provider_id: provider.id, model_id: 'real-model', display_name: null })
  models.addAlias({ protocol: 'openai', alias_name: aliasName, provider_id: provider.id, model_id: 'real-model', routing_config: routingConfig })
}

function appWithProxy(): Hono {
  const app = new Hono()
  app.route('/openai', proxyRoutes)
  app.route('/anthropic', proxyRoutes)
  return app
}

test('single mode intercepts retryable upstream errors instead of passing through the upstream body', async () => {
  upstreamPort = await startUpstream((req, res) => {
    seenHeaders = req.headers
    assert.equal(req.url, '/v1/chat/completions')
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
    res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }))
  })
  await setupSingleAlias('http://127.0.0.1:' + upstreamPort, 'single-alias')

  const app = appWithProxy()
  const res = await app.request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'single-alias', messages: [{ role: 'user', content: 'hi' }] }),
  })

  assert.equal(res.status, 502)
  assert.equal(res.headers.get('retry-after'), '30')
  // 上游必须收到 Provider 凭据（解密后的 auth_json），而不是客户端 Token 或空头
  assert.equal(seenHeaders?.authorization, 'Bearer sk-upstream')
  const body = await res.json() as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'upstream_rate_limited')
  assert.match(body.error.message, /HTTP 429/)
  assert.notEqual(body.error.message, 'rate limited')
})

test('failover mode still wraps retryable 4xx as 502 instead of passing it through', async () => {
  upstreamPort = await startUpstream((req, res) => {
    seenHeaders = req.headers
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
    res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }))
  })
  await setupSingleAlias('http://127.0.0.1:' + upstreamPort, 'failover-alias', { mode: 'failover', max_attempts: 1, cooldown_seconds: 60 })

  const app = appWithProxy()
  const res = await app.request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'failover-alias', messages: [{ role: 'user', content: 'hi' }] }),
  })

  assert.equal(res.status, 502)
  assert.equal(res.headers.get('retry-after'), '30')
  const body = await res.json() as { error: { code: string } }
  assert.equal(body.error.code, 'upstream_rate_limited')
  const remaining = getHealthSnapshot('openai/failover-alias').cooldowns[0]!.until - Date.now()
  assert.ok(remaining > 25_000 && remaining <= 30_000)
})

test('single mode still wraps upstream 5xx as 502', async () => {
  upstreamPort = await startUpstream((req, res) => {
    seenHeaders = req.headers
    assert.equal(req.url, '/v1/chat/completions')
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'internal' } }))
  })
  await setupSingleAlias('http://127.0.0.1:' + upstreamPort, 'single-alias-5xx')

  const app = appWithProxy()
  const res = await app.request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'single-alias-5xx', messages: [{ role: 'user', content: 'hi' }] }),
  })

  assert.equal(res.status, 502)
  assert.equal(seenHeaders?.authorization, 'Bearer sk-upstream')
  const body = await res.json() as { error: { code: string } }
  assert.equal(body.error.code, 'upstream_error')
})

test('Anthropic Models API shape returns mapping names as model objects', async () => {
  upstreamPort = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  })
  await setupSingleAlias('http://127.0.0.1:' + upstreamPort, 'anthropic-model-alias')
  // 建一条 anthropic 映射
  const provider = providers.createProvider({
    name: 'anthropic-upstream',
    protocol: 'anthropic',
    group_id: null,
    base_url: 'http://127.0.0.1:' + upstreamPort,
    auth_json: JSON.stringify({ api_key: 'sk-ant' }),
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
  })
  models.addModel({ provider_id: provider.id, model_id: 'claude-x', display_name: null })
  models.addAlias({ protocol: 'anthropic', alias_name: 'claude-alias', provider_id: provider.id, model_id: 'claude-x' })

  const app = appWithProxy()
  const res = await app.request('http://localhost/anthropic/v1/models', {
    headers: { authorization: `Bearer ${getAdminToken()}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json() as {
    data: Array<{ id: string; type: string; display_name: string }>
    has_more: boolean
    first_id: string | null
    last_id: string | null
  }
  assert.ok(Array.isArray(body.data))
  const names = body.data.map((m) => m.id)
  assert.ok(names.includes('claude-alias'))
  for (const item of body.data) {
    assert.equal(item.type, 'model')
    assert.equal(item.display_name, item.id)
    assert.equal((item as { object?: string }).object, undefined)
    assert.equal((item as { owned_by?: string }).owned_by, undefined)
  }
  assert.equal(body.has_more, false)
  assert.equal(body.first_id, names[0] ?? null)
  assert.equal(body.last_id, names.length ? names[names.length - 1] : null)
})

test('OpenAI Models list keeps object list shape', async () => {
  upstreamPort = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  })
  await setupSingleAlias('http://127.0.0.1:' + upstreamPort, 'openai-model-alias')

  const app = appWithProxy()
  const res = await app.request('http://localhost/openai/v1/models', {
    headers: { authorization: `Bearer ${getAdminToken()}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json() as { object: string; data: Array<{ id: string; object: string; owned_by: string }> }
  assert.equal(body.object, 'list')
  const entry = body.data.find((m) => m.id === 'openai-model-alias')
  assert.ok(entry)
  assert.equal(entry.object, 'model')
  assert.equal(entry.owned_by, 'gateway')
})

test('proxy fails closed when provider credentials cannot be decrypted', async () => {
  upstreamPort = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [] }))
  })
  await setupSingleAlias('http://127.0.0.1:' + upstreamPort, 'undecrypt-alias')
  // 破坏密文，模拟 ENCRYPTION_KEY 丢失
  db.prepare("UPDATE providers SET auth_json = '', auth_json_encrypted = 'ab:cd:ef' WHERE name = 'passthrough-upstream'").run()

  const app = appWithProxy()
  const res = await app.request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'undecrypt-alias', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 502)
  const body = await res.json() as { error: { code: string } }
  assert.equal(body.error.code, 'upstream_error')
})

test('failover exhausts provider keys before moving to the next candidate', async () => {
  const seen: Array<{ key: string | undefined; body: string }> = []
  upstreamPort = await startUpstream((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const key = req.headers.authorization
      seen.push({ key, body: Buffer.concat(chunks).toString() })
      if (key === 'Bearer sk-last') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      } else {
        res.writeHead(429, { 'retry-after': '20' })
        res.end('{"error":"quota"}')
      }
    })
  })
  const base = 'http://127.0.0.1:' + upstreamPort
  const first = providers.createProvider({ name: 'pool-first', protocol: 'openai', group_id: null, base_url: base, auth_json: JSON.stringify({ api_keys: [
    { id: 'a', name: 'A', key: 'sk-a', enabled: true },
    { id: 'b', name: 'B', key: 'sk-b', enabled: true },
  ], key_strategy: 'priority' }), custom_headers_json: '{}', proxy_url: null, timeout_ms: null, model_filter: null })
  const second = providers.createProvider({ name: 'pool-second', protocol: 'openai', group_id: null, base_url: base, auth_json: JSON.stringify({ api_key: 'sk-last' }), custom_headers_json: '{}', proxy_url: null, timeout_ms: null, model_filter: null })
  models.addModel({ provider_id: first.id, model_id: 'real-model', display_name: null })
  models.addModel({ provider_id: second.id, model_id: 'real-model', display_name: null })
  models.addAlias({ protocol: 'openai', alias_name: 'pool-failover', provider_id: first.id, model_id: 'real-model', routing_config: { mode: 'failover' } })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'pool-failover', provider_id: second.id, model_id: 'real-model' })

  const res = await appWithProxy().request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: '{"model":"pool-failover", "messages":[], "metadata":{"model":"untouched"}}',
  })
  assert.equal(res.status, 200)
  assert.deepEqual(seen.map((item) => item.key), ['Bearer sk-a', 'Bearer sk-b', 'Bearer sk-last'])
  assert.ok(seen.every((item) => item.body === '{"model":"real-model", "messages":[], "metadata":{"model":"untouched"}}'))
})

test('failover switches real models when the first upstream returns 404', async () => {
  const seenModels: string[] = []
  upstreamPort = await startUpstream((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string }
      seenModels.push(body.model)
      if (body.model === 'missing-model') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"model not found"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  const base = 'http://127.0.0.1:' + upstreamPort
  const first = providers.createProvider({ name: 'model-first', protocol: 'openai', group_id: null, base_url: base, auth_json: JSON.stringify({ api_key: 'sk-first' }), custom_headers_json: '{}', proxy_url: null, timeout_ms: null, model_filter: null })
  const second = providers.createProvider({ name: 'model-second', protocol: 'openai', group_id: null, base_url: base, auth_json: JSON.stringify({ api_key: 'sk-second' }), custom_headers_json: '{}', proxy_url: null, timeout_ms: null, model_filter: null })
  models.addModel({ provider_id: first.id, model_id: 'missing-model', display_name: null })
  models.addModel({ provider_id: second.id, model_id: 'working-model', display_name: null })
  models.addAlias({ protocol: 'openai', alias_name: 'model-failover', provider_id: first.id, model_id: 'missing-model', routing_config: { mode: 'failover' } })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'model-failover', provider_id: second.id, model_id: 'working-model' })

  const res = await appWithProxy().request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-failover', messages: [] }),
  })

  assert.equal(res.status, 200)
  assert.deepEqual(seenModels, ['missing-model', 'working-model'])
})

test('client request errors (4xx) are returned as-is without switching keys or cooling', async () => {
  const seen: string[] = []
  let calls = 0
  upstreamPort = await startUpstream((req, res) => {
    seen.push(req.headers.authorization ?? '')
    calls++
    if (calls === 1) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"invalid_parameter"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const provider = providers.createProvider({ name: 'pool-400', protocol: 'openai', group_id: null, base_url: 'http://127.0.0.1:' + upstreamPort, auth_json: JSON.stringify({ api_keys: [
    { id: 'a', name: 'A', key: 'sk-a', enabled: true },
    { id: 'b', name: 'B', key: 'sk-b', enabled: true },
  ] }), custom_headers_json: '{}', proxy_url: null, timeout_ms: null, model_filter: null })
  models.addModel({ provider_id: provider.id, model_id: 'real-model', display_name: null })
  models.addAlias({ protocol: 'openai', alias_name: 'pool-invalid', provider_id: provider.id, model_id: 'real-model', routing_config: { mode: 'failover' } })
  const app = appWithProxy()
  const res = await app.request('http://localhost/openai/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'pool-invalid', messages: [] }),
  })
  // 客户端错误 4xx 是请求问题：按原始状态码返回，只尝试一把 Key，不透传上游错误体
  assert.equal(res.status, 400)
  assert.deepEqual(seen, ['Bearer sk-a'])
  const body = await res.json() as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'upstream_request_error')
  assert.notEqual(body.error.message, 'invalid_parameter')
  // 不被毒化：既没有候选冷却，也没有 Key 冷却，紧随的合法请求仍能成功
  assert.deepEqual(getHealthSnapshot('openai/pool-invalid').cooldowns, [])
  const ok = await app.request('http://localhost/openai/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'pool-invalid', messages: [] }),
  })
  assert.equal(ok.status, 200)
})

test('ambiguous transport error skips the provider without cooling the candidate', async () => {
  upstreamPort = await startUpstream((req) => {
    // never responds → client-side headers timeout (ambiguous delivery result)
    req.resume()
  })
  const base = 'http://127.0.0.1:' + upstreamPort
  const first = providers.createProvider({ name: 'ambig-first', protocol: 'openai', group_id: null, base_url: base, auth_json: JSON.stringify({ api_key: 'sk-ambig-first' }), custom_headers_json: '{}', proxy_url: null, timeout_ms: 150, model_filter: null })
  const second = providers.createProvider({ name: 'ambig-second', protocol: 'openai', group_id: null, base_url: base, auth_json: JSON.stringify({ api_key: 'sk-ambig-second' }), custom_headers_json: '{}', proxy_url: null, timeout_ms: 150, model_filter: null })
  models.addModel({ provider_id: first.id, model_id: 'ambig-model-a', display_name: null })
  models.addModel({ provider_id: second.id, model_id: 'ambig-model-b', display_name: null })
  models.addAlias({ protocol: 'openai', alias_name: 'ambig-failover', provider_id: first.id, model_id: 'ambig-model-a', routing_config: { mode: 'failover', cooldown_seconds: 60 } })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'ambig-failover', provider_id: second.id, model_id: 'ambig-model-b' })

  const res = await appWithProxy().request('http://localhost/openai/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'ambig-failover', messages: [] }),
  })
  // 两个候选都在响应头阶段超时（结果不明）：不重放、不冷却，最终返回 504
  assert.equal(res.status, 504)
  // 结果不明的传输错误不得把候选标记为失败/冷却
  assert.deepEqual(getHealthSnapshot('openai/ambig-failover').cooldowns, [])
})

test('headers timeout does not replay an ambiguously sent request on another key', async () => {
  const seen: string[] = []
  upstreamPort = await startUpstream((req) => {
    seen.push(req.headers.authorization ?? '')
    req.resume()
  })
  const provider = providers.createProvider({ name: 'pool-timeout', protocol: 'openai', group_id: null, base_url: 'http://127.0.0.1:' + upstreamPort, auth_json: JSON.stringify({ api_keys: [
    { id: 'a', name: 'A', key: 'sk-a', enabled: true },
    { id: 'b', name: 'B', key: 'sk-b', enabled: true },
  ] }), custom_headers_json: '{}', proxy_url: null, timeout_ms: 150, model_filter: null })
  models.addModel({ provider_id: provider.id, model_id: 'real-model', display_name: null })
  models.addAlias({ protocol: 'openai', alias_name: 'pool-timeout', provider_id: provider.id, model_id: 'real-model' })
  const res = await appWithProxy().request('http://localhost/openai/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'pool-timeout', messages: [] }),
  })
  assert.equal(res.status, 504)
  // Headers timeout has an ambiguous delivery result. The gateway must not
  // replay with another configured key; an in-flight connection may still
  // reach the test server after undici reports the timeout without headers.
  assert.deepEqual(seen.filter((key) => key.length > 0), ['Bearer sk-a'])
  assert.ok(!seen.includes('Bearer sk-b'))
})

test('headers timeout skips the current provider and switches to the next model provider', async () => {
  const seen: string[] = []
  let calls = 0
  upstreamPort = await startUpstream((req, res) => {
    seen.push(req.headers.authorization ?? '')
    calls++
    req.resume()
    if (calls === 1) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const base = 'http://127.0.0.1:' + upstreamPort
  const first = providers.createProvider({ name: 'timeout-first', protocol: 'openai', group_id: null, base_url: base, auth_json: JSON.stringify({ api_key: 'sk-timeout-first' }), custom_headers_json: '{}', proxy_url: null, timeout_ms: 150, model_filter: null })
  const second = providers.createProvider({ name: 'timeout-second', protocol: 'openai', group_id: null, base_url: base, auth_json: JSON.stringify({ api_key: 'sk-timeout-second' }), custom_headers_json: '{}', proxy_url: null, timeout_ms: 1000, model_filter: null })
  models.addModel({ provider_id: first.id, model_id: 'slow-model', display_name: null })
  models.addModel({ provider_id: second.id, model_id: 'fallback-model', display_name: null })
  models.addAlias({ protocol: 'openai', alias_name: 'timeout-failover', provider_id: first.id, model_id: 'slow-model', routing_config: { mode: 'failover' } })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'timeout-failover', provider_id: second.id, model_id: 'fallback-model' })

  const res = await appWithProxy().request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'timeout-failover', messages: [] }),
  })

  assert.equal(res.status, 200)
  assert.deepEqual(seen.filter((key) => key.length > 0), ['Bearer sk-timeout-first', 'Bearer sk-timeout-second'])
})

test('only connection-stage transport errors are safe to retry', () => {
  assert.equal(isSafeToRetryTransportError(Object.assign(new Error('connect'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), true)
  assert.equal(isSafeToRetryTransportError(new Error('wrapped', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })), true)
  assert.equal(isSafeToRetryTransportError(Object.assign(new Error('headers'), { code: 'UND_ERR_HEADERS_TIMEOUT' })), false)
  assert.equal(isSafeToRetryTransportError(Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' })), false)
})
