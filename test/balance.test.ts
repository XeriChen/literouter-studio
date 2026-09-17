import { after, describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'

// 必须先切到临时 cwd，再动态 import 依赖 db 的模块：src/db/index.ts 按 process.cwd() 解析
// 数据库路径，静态 import 会让本文件直接在仓库的 data/gateway.db 上跑（会删除真实 Provider 配置）。
const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-balance-'))
process.chdir(tempRoot)

const { getProviderBalance, resetBalanceRuntimeState, listBalanceSnapshots, captureDailyBalanceSnapshot } = await import('../src/services/balance')
const { UpstreamError } = await import('../src/services/errors')
const { createProvider } = await import('../src/services/providers')
const { db } = await import('../src/db')
const { isSensitiveKey, redactObject, redactText } = await import('../src/services/redact')

after(async () => {
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

function startMockUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; baseUrl: string; hits: () => number }> {
  let hits = 0
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      hits++
      handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      // unref：测试结束不被监听句柄挂住
      server.unref()
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, hits: () => hits })
    })
  })
}

describe('balance service', () => {
  afterEach(() => {
    resetBalanceRuntimeState()
    db.exec('DELETE FROM providers')
    db.exec('DELETE FROM balance_snapshots')
  })

  it('rejects non-balance provider with balance_unsupported', async () => {
    db.exec('DELETE FROM providers')
    const provider = createProvider({
      name: 'Standard OpenAI',
      protocol: 'openai',
      group_id: null,
      base_url: 'https://api.openai.com/v1',
      auth_json: JSON.stringify({ api_key: 'sk-test' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: null,
    })

    await assert.rejects(
      () => getProviderBalance(provider.id),
      (err: unknown) => err instanceof UpstreamError && err.code === 'balance_unsupported',
    )
  })

  it('rejects missing provider with provider_not_found', async () => {
    await assert.rejects(
      () => getProviderBalance('nonexistent'),
      (err: unknown) => err instanceof UpstreamError && err.code === 'provider_not_found',
    )
  })

  it('queries newapi billing endpoints with sk- key and persists a daily snapshot', async () => {
    db.exec('DELETE FROM providers')
    const seen = new Set<string>()
    const upstream = await startMockUpstream((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer sk-upstream')
      const path = (req.url ?? '').split('?')[0]
      seen.add(path)
      res.setHeader('content-type', 'application/json')
      if (path === '/v1/dashboard/billing/subscription') {
        // hard_limit_usd = (remain + used) / QuotaPerUnit = 25 USD
        res.end(JSON.stringify({
          object: 'billing_subscription',
          has_payment_method: true,
          soft_limit_usd: 25,
          hard_limit_usd: 25,
          system_hard_limit_usd: 25,
          access_until: 1_893_456_000,
        }))
        return
      }
      if (path === '/v1/dashboard/billing/usage') {
        // total_usage 单位为美分：2000 = 20 USD 已用
        res.end(JSON.stringify({ object: 'list', total_usage: 2000 }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const provider = createProvider({
      name: 'NewAPI',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })

    const result = await getProviderBalance(provider.id, { force: true })
    assert.equal(result.success, true)
    assert.equal(result.balance, 5, 'remaining = hard_limit_usd - total_usage/100')
    assert.equal(result.currency, 'USD')
    assert.equal(result.status_code, 200)
    assert.equal(result.error, null)
    assert.equal(result.available, true)
    assert.equal(result.unlimited, false)
    assert.equal(result.expires_at, new Date(1_893_456_000_000).toISOString())
    assert.deepEqual(result.balances, [
      { label: '剩余', balance: 5, currency: 'USD' },
      { label: '已用', balance: 20, currency: 'USD' },
      { label: '总额', balance: 25, currency: 'USD' },
    ])
    assert.deepEqual([...seen].sort(), [
      '/v1/dashboard/billing/subscription',
      '/v1/dashboard/billing/usage',
    ])

    const snapshots = listBalanceSnapshots(provider.id)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].balance, 5)
    upstream.server.close()
  })

  it('tolerates a base_url ending with /v1', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      assert.ok(path.startsWith('/v1/dashboard/billing/'))
      res.setHeader('content-type', 'application/json')
      if (path === '/v1/dashboard/billing/subscription') {
        res.end(JSON.stringify({ hard_limit_usd: 25 }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const provider = createProvider({
      name: 'NewAPI-V1',
      protocol: 'openai',
      group_id: null,
      base_url: `${upstream.baseUrl}/v1`,
      auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })

    const result = await getProviderBalance(provider.id, { force: true })
    assert.equal(result.success, true)
    assert.equal(result.balance, 25)
    assert.equal(result.expires_at, null)
    upstream.server.close()
  })

  it('degrades to total quota when the usage endpoint is unavailable', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      res.setHeader('content-type', 'application/json')
      if (path === '/v1/dashboard/billing/subscription') {
        res.end(JSON.stringify({ hard_limit_usd: 25, access_until: 0 }))
        return
      }
      // 精简 fork 未实现 usage
      res.statusCode = 404
      res.end()
    })
    const provider = createProvider({
      name: 'NewAPI-NoUsage',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })

    const result = await getProviderBalance(provider.id, { force: true })
    assert.equal(result.success, true)
    assert.equal(result.balance, 25, 'fallback balance equals hard_limit_usd')
    assert.deepEqual(result.balances, [
      { label: '剩余', balance: 25, currency: 'USD' },
      { label: '总额', balance: 25, currency: 'USD' },
    ])
    upstream.server.close()
  })

  it('degrades to total quota when the usage endpoint returns 401', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      res.setHeader('content-type', 'application/json')
      if (path === '/v1/dashboard/billing/subscription') {
        // subscription 200 已验证密钥有效；部分 fork 对 usage 单独限权
        res.end(JSON.stringify({ hard_limit_usd: 10 }))
        return
      }
      res.statusCode = 401
      res.end(JSON.stringify({ error: { message: 'Invalid token' } }))
    })
    const provider = createProvider({
      name: 'NewAPI-Usage401',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })

    const result = await getProviderBalance(provider.id, { force: true })
    assert.equal(result.success, true)
    assert.equal(result.balance, 10)
    assert.deepEqual(result.balances, [
      { label: '剩余', balance: 10, currency: 'USD' },
      { label: '总额', balance: 10, currency: 'USD' },
    ])
    upstream.server.close()
  })

  it('reports unlimited keys as unlimited with usage only and writes no snapshot', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      res.setHeader('content-type', 'application/json')
      if (path === '/v1/dashboard/billing/subscription') {
        // new-api 对 unlimited 令牌硬编码 hard_limit_usd = 100000000
        res.end(JSON.stringify({ hard_limit_usd: 100_000_000, access_until: 1_893_456_000 }))
        return
      }
      if (path === '/v1/dashboard/billing/usage') {
        // 8298.781 美分 = 82.98781 USD
        res.end(JSON.stringify({ object: 'list', total_usage: 8298.781 }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const provider = createProvider({
      name: 'NewAPI-Unlimited',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })

    const result = await getProviderBalance(provider.id, { force: true })
    assert.equal(result.success, true)
    assert.equal(result.unlimited, true)
    assert.equal(result.balance, null, 'unlimited key has no finite remaining balance')
    assert.equal(result.available, true)
    assert.equal(result.expires_at, new Date(1_893_456_000_000).toISOString())
    assert.deepEqual(result.balances, [
      { label: '已用', balance: 82.98781, currency: 'USD' },
    ])

    assert.equal(listBalanceSnapshots(provider.id).length, 0, 'unlimited results do not snapshot balance')
    upstream.server.close()
  })

  it('reports unlimited keys even when the usage endpoint is unavailable', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      res.setHeader('content-type', 'application/json')
      if (path === '/v1/dashboard/billing/subscription') {
        res.end(JSON.stringify({ hard_limit_usd: 100_000_000 }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const provider = createProvider({
      name: 'NewAPI-Unlimited-NoUsage',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })

    const result = await getProviderBalance(provider.id, { force: true })
    assert.equal(result.success, true)
    assert.equal(result.unlimited, true)
    assert.equal(result.balance, null)
    assert.deepEqual(result.balances, [])
    assert.equal(result.expires_at, null)
    upstream.server.close()
  })

  it('only treats the exact 1e8 sentinel as unlimited', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      res.setHeader('content-type', 'application/json')
      if (path === '/v1/dashboard/billing/subscription') {
        // 差 1 也不是无限额哨兵：真实大额额度必须按有限额度计算
        res.end(JSON.stringify({ hard_limit_usd: 99_999_999 }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const provider = createProvider({
      name: 'NewAPI-HugeButFinite',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })

    const result = await getProviderBalance(provider.id, { force: true })
    assert.equal(result.unlimited, false)
    assert.equal(result.balance, 99_999_999)
    assert.deepEqual(result.balances, [
      { label: '剩余', balance: 99_999_999, currency: 'USD' },
      { label: '总额', balance: 99_999_999, currency: 'USD' },
    ])
    upstream.server.close()
  })

  it('treats HTTP 200 with an error body as upstream failure', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      res.setHeader('content-type', 'application/json')
      if (path === '/v1/dashboard/billing/subscription') {
        res.end(JSON.stringify({ error: { message: 'database error', type: 'new_api_error' } }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    const provider = createProvider({
      name: 'NewAPI-ErrorBody',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ api_key: 'sk-upstream' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })
    await assert.rejects(
      () => getProviderBalance(provider.id, { force: true }),
      (err: unknown) => err instanceof UpstreamError && err.code === 'upstream_error' && /database error/.test(err.message),
    )
    upstream.server.close()
  })

  it('dedupes concurrent queries and serves TTL cache without hitting upstream', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ balance: 12.5 }))
    })
    const provider = createProvider({
      name: 'Sub2API',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ access_token: 'tok' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'sub2api',
    })

    const [a, b] = await Promise.all([
      getProviderBalance(provider.id, { force: true }),
      getProviderBalance(provider.id, { force: true }),
    ])
    assert.equal(a.balance, 12.5)
    assert.equal(b.balance, 12.5)
    assert.equal(upstream.hits(), 1, 'concurrent queries share one upstream call')

    const cached = await getProviderBalance(provider.id)
    assert.equal(cached.balance, 12.5)
    assert.equal(upstream.hits(), 1, 'TTL cache avoids upstream')

    await getProviderBalance(provider.id, { force: true })
    assert.equal(upstream.hits(), 2, 'force bypasses cache')
    upstream.server.close()
  })

  it('maps upstream 401 to upstream_auth_error', async () => {
    db.exec('DELETE FROM providers')
    const upstream = await startMockUpstream((req, res) => {
      res.statusCode = 401
      res.end(JSON.stringify({ message: 'unauthorized' }))
    })
    const provider = createProvider({
      name: 'NewAPI-401',
      protocol: 'openai',
      group_id: null,
      base_url: upstream.baseUrl,
      auth_json: JSON.stringify({ api_key: 'sk-bad' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })
    await assert.rejects(
      () => getProviderBalance(provider.id, { force: true }),
      (err: unknown) => err instanceof UpstreamError && err.code === 'upstream_auth_error' && err.upstreamStatus === 401,
    )
    upstream.server.close()
  })

  it('daily snapshot upsert keeps one row per day with latest balance', () => {
    db.exec('DELETE FROM providers')
    const provider = createProvider({
      name: 'SnapshotProvider',
      protocol: 'openai',
      group_id: null,
      base_url: 'https://example.test',
      auth_json: JSON.stringify({ api_key: 'sk-test' }),
      custom_headers_json: '{}',
      proxy_url: null,
      timeout_ms: null,
      model_filter: null,
      upstream_type: 'newapi',
    })
    const fixed = (offsetMs: number) => new Date(Date.UTC(2026, 8, 13, 3, 0, 0) + offsetMs)
    const base: Parameters<typeof captureDailyBalanceSnapshot>[1] = {
      success: true, balance: 1, currency: 'USD', balances: [], unlimited: false, available: true,
      status_code: 200, fetched_at: fixed(0).toISOString(), error: null, expires_at: null,
    }
    captureDailyBalanceSnapshot(provider.id, base, fixed(0))
    captureDailyBalanceSnapshot(provider.id, { ...base, balance: 9 }, fixed(60_000))
    const rows = listBalanceSnapshots(provider.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].balance, 9)
  })
})

describe('redaction', () => {
  it('flags sensitive keys', () => {
    for (const key of ['Authorization', 'api_key', 'x-api-key', 'access_token', 'SECRET', 'password']) {
      assert.equal(isSensitiveKey(key), true, key)
    }
    assert.equal(isSensitiveKey('model'), false)
  })

  it('redacts bare secrets in text', () => {
    const text = 'failed with key sk-abcdef1234567890 and Bearer eyJhbGciOi.JK.v9'
    const redacted = redactText(text)
    assert.ok(!redacted.includes('sk-abcdef1234567890'))
    assert.ok(redacted.includes('sk-***'))
    assert.ok(redacted.includes('Bearer ***'))
  })

  it('redacts sensitive key values in objects', () => {
    const output = redactObject({ authorization: 'Bearer abc', api_key: 'sk-x', model: 'gpt-4', nested: { token: 't' } })
    assert.deepEqual(output, { authorization: '***', api_key: '***', model: 'gpt-4', nested: { token: '***' } })
  })
})
