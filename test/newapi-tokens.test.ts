import { after, describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'

// 先切临时 cwd 再动态 import 依赖 db 的模块（src/db 按 cwd 解析库路径），避免污染真实开发库
const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-newapi-tokens-'))
process.chdir(tempRoot)

const {
  listNewApiTokens,
  revealNewApiTokenKey,
  createNewApiToken,
  updateNewApiToken,
  deleteNewApiToken,
  importNewApiTokensToPool,
} = await import('../src/services/newapi-tokens')
const { UpstreamError } = await import('../src/services/errors')
const { createProvider, getProvider } = await import('../src/services/providers')
const { parseAuth } = await import('../src/providers/headers')
const { db } = await import('../src/db')

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

interface Capture {
  method: string
  path: string
  auth: string | undefined
  body: unknown
}

function startMockUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: unknown, captures: Capture[]) => void,
): Promise<{ server: http.Server; baseUrl: string; captures: Capture[] }> {
  const captures: Capture[] = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: unknown
        try {
          body = raw ? JSON.parse(raw) : undefined
        } catch {
          body = raw
        }
        captures.push({
          method: req.method ?? '',
          path: (req.url ?? '').split('?')[0],
          auth: req.headers.authorization,
          body,
        })
        handler(req, res, body, captures)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.unref()
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, captures })
    })
  })
}

function makeProvider(baseUrl: string, auth: Record<string, unknown> = { access_token: 'pat-token' }) {
  db.exec('DELETE FROM providers')
  const row = createProvider({
    name: 'NewAPI',
    protocol: 'openai',
    group_id: null,
    base_url: baseUrl,
    auth_json: JSON.stringify(auth),
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
    upstream_type: 'newapi',
  })
  return getProvider(row.id)!
}

function jsonRes(res: http.ServerResponse, payload: unknown, status = 200) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

describe('newapi token management', () => {
  afterEach(() => {
    db.exec('DELETE FROM providers')
  })

  it('lists tokens and normalizes quota to USD, masking and unlimited', async () => {
    const upstream = await startMockUpstream((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer pat-token')
      jsonRes(res, {
        success: true,
        message: '',
        data: {
          page: 1,
          page_size: 20,
          total: 2,
          items: [
            { id: 1, name: 'main', key: 'sk-****abcd', status: 1, unlimited_quota: false, remain_quota: 2_500_000, used_quota: 500_000, expired_time: -1, group: 'default' },
            { id: 2, name: 'infinite', key: 'sk-****ef01', status: 2, unlimited_quota: true, remain_quota: 0, used_quota: 1_000_000, expired_time: 1_893_456_000, group: '' },
          ],
        },
      })
    })
    const provider = makeProvider(upstream.baseUrl)

    const page = await listNewApiTokens(provider, 'pat-token', { page: 1, size: 20 })
    assert.equal(upstream.captures[0].path, '/api/token/')
    assert.equal(page.total, 2)
    assert.deepEqual(page.items[0], {
      id: 1, name: 'main', key: 'sk-****abcd', status: 1, unlimited: false,
      remain_usd: 5, used_usd: 1, expired_time: -1, group: 'default',
    })
    assert.equal(page.items[1].unlimited, true)
    assert.equal(page.items[1].remain_usd, null, 'unlimited token has no finite remaining')
    assert.equal(page.items[1].used_usd, 2)
    upstream.server.close()
  })

  it('reveals the full key via POST /:id/key', async () => {
    const upstream = await startMockUpstream((req, res) => {
      assert.equal(req.method, 'POST')
      assert.equal((req.url ?? '').split('?')[0], '/api/token/9/key')
      jsonRes(res, { success: true, data: { key: 'sk-full-secret-9' } })
    })
    const provider = makeProvider(upstream.baseUrl)

    const key = await revealNewApiTokenKey(provider, 'pat-token', 9)
    assert.equal(key, 'sk-full-secret-9')
    upstream.server.close()
  })

  it('creates a token converting USD quota to internal units', async () => {
    const upstream = await startMockUpstream((req, res) => jsonRes(res, { success: true, data: null }))
    const provider = makeProvider(upstream.baseUrl)

    await createNewApiToken(provider, 'pat-token', { name: 'ci', unlimited: false, quota_usd: 3, expired_time: -1, group: 'vip' })
    assert.equal(upstream.captures[0].method, 'POST')
    assert.equal(upstream.captures[0].path, '/api/token/')
    assert.deepEqual(upstream.captures[0].body, {
      name: 'ci', unlimited_quota: false, remain_quota: 1_500_000, expired_time: -1, group: 'vip',
    })
    upstream.server.close()
  })

  it('updates status only via ?status_only=1 without touching other fields', async () => {
    const upstream = await startMockUpstream((req, res) => jsonRes(res, { success: true, data: null }))
    const provider = makeProvider(upstream.baseUrl)

    await updateNewApiToken(provider, 'pat-token', { id: 4, status: 2 })
    assert.equal(upstream.captures[0].method, 'PUT')
    assert.equal((upstream.captures[0] as { path: string }).path, '/api/token/')
    assert.deepEqual(upstream.captures[0].body, { id: 4, status: 2 })
    upstream.server.close()
  })

  it('updates full fields when name/quota/expiry are provided', async () => {
    const upstream = await startMockUpstream((req, res) => jsonRes(res, { success: true, data: null }))
    const provider = makeProvider(upstream.baseUrl)

    await updateNewApiToken(provider, 'pat-token', { id: 5, name: 'renamed', unlimited: false, quota_usd: 2, expired_time: -1 })
    assert.equal(upstream.captures[0].method, 'PUT')
    assert.deepEqual(upstream.captures[0].body, {
      id: 5, name: 'renamed', unlimited_quota: false, remain_quota: 1_000_000, expired_time: -1,
    })
    upstream.server.close()
  })

  it('deletes a token', async () => {
    const upstream = await startMockUpstream((req, res) => jsonRes(res, { success: true, data: null }))
    const provider = makeProvider(upstream.baseUrl)

    await deleteNewApiToken(provider, 'pat-token', 7)
    assert.equal(upstream.captures[0].method, 'DELETE')
    assert.equal(upstream.captures[0].path, '/api/token/7')
    upstream.server.close()
  })

  it('imports selected tokens into the local key pool, migrating a legacy api_key', async () => {
    const upstream = await startMockUpstream((req, res, _body, captures) => {
      const path = captures[captures.length - 1].path
      const id = Number(path.split('/')[3])
      jsonRes(res, { success: true, data: { key: `sk-real-${id}` } })
    })
    const provider = makeProvider(upstream.baseUrl, { access_token: 'pat-token', api_key: 'sk-legacy' })

    const result = await importNewApiTokensToPool(provider, 'pat-token', [
      { id: 1, name: 'first' },
      { id: 2, name: 'second' },
    ])
    assert.deepEqual(result, { added: 2, skipped: 0, pool_size: 3 })

    const auth = parseAuth(getProvider(provider.id)!)
    assert.equal(auth.api_key, undefined, 'legacy single key is folded into the pool')
    assert.equal(auth.key_strategy, 'polling')
    assert.deepEqual(auth.api_keys?.map((k) => ({ name: k.name, key: k.key, enabled: k.enabled })), [
      { name: 'Default', key: 'sk-legacy', enabled: true },
      { name: 'first', key: 'sk-real-1', enabled: true },
      { name: 'second', key: 'sk-real-2', enabled: true },
    ])
    upstream.server.close()
  })

  it('skips import of keys already present in the pool', async () => {
    const upstream = await startMockUpstream((req, res, _body, captures) => {
      const id = Number(captures[captures.length - 1].path.split('/')[3])
      jsonRes(res, { success: true, data: { key: id === 1 ? 'sk-dup' : 'sk-new' } })
    })
    const provider = makeProvider(upstream.baseUrl, {
      access_token: 'pat-token',
      api_keys: [{ id: 'k1', name: 'Existing', key: 'sk-dup', enabled: true }],
      key_strategy: 'random',
    })

    const result = await importNewApiTokensToPool(provider, 'pat-token', [
      { id: 1, name: 'dup' },
      { id: 2, name: 'fresh' },
    ])
    assert.deepEqual(result, { added: 1, skipped: 1, pool_size: 2 })
    const auth = parseAuth(getProvider(provider.id)!)
    assert.equal(auth.key_strategy, 'random', 'existing strategy is preserved')
    assert.deepEqual(auth.api_keys?.map((k) => k.key), ['sk-dup', 'sk-new'])
    upstream.server.close()
  })

  it('maps HTTP 401 to upstream_auth_error', async () => {
    const upstream = await startMockUpstream((req, res) => jsonRes(res, { success: false, message: 'unauthorized' }, 401))
    const provider = makeProvider(upstream.baseUrl)

    await assert.rejects(
      () => listNewApiTokens(provider, 'pat-token', { page: 1, size: 20 }),
      (err: unknown) => err instanceof UpstreamError && err.code === 'upstream_auth_error' && err.upstreamStatus === 401,
    )
    upstream.server.close()
  })

  it('surfaces HTTP 200 success=false as upstream_error with the upstream message', async () => {
    const upstream = await startMockUpstream((req, res) => jsonRes(res, { success: false, message: '已达到最大令牌数量限制 (10)' }))
    const provider = makeProvider(upstream.baseUrl)

    await assert.rejects(
      () => createNewApiToken(provider, 'pat-token', { name: 'x', unlimited: true }),
      (err: unknown) => err instanceof UpstreamError && err.code === 'upstream_error' && /最大令牌数量/.test(err.message),
    )
    upstream.server.close()
  })
})

