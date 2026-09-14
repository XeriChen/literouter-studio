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

test('single mode passes through retryable 4xx with original status, body and Retry-After', async () => {
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

  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '30')
  // 上游必须收到 Provider 凭据（解密后的 auth_json），而不是客户端 Token 或空头
  assert.equal(seenHeaders?.authorization, 'Bearer sk-upstream')
  const body = await res.json() as { error: { message: string } }
  assert.equal(body.error.message, 'rate limited')
})

test('failover mode still wraps retryable 4xx as 502 instead of passing it through', async () => {
  upstreamPort = await startUpstream((req, res) => {
    seenHeaders = req.headers
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
    res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }))
  })
  await setupSingleAlias('http://127.0.0.1:' + upstreamPort, 'failover-alias', { mode: 'failover', max_attempts: 1, cooldown_seconds: 30 })

  const app = appWithProxy()
  const res = await app.request('http://localhost/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${getAdminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'failover-alias', messages: [{ role: 'user', content: 'hi' }] }),
  })

  assert.equal(res.status, 502)
  assert.equal(res.headers.get('retry-after'), null)
  const body = await res.json() as { error: { code: string } }
  assert.equal(body.error.code, 'upstream_rate_limited')
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
