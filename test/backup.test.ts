import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-backup-'))
process.chdir(tempRoot)

const { db } = await import('../src/db/index')
const providers = await import('../src/services/providers')
const models = await import('../src/services/models')
const backup = await import('../src/services/backup')
const { api } = await import('../src/routes/api')
const { getAdminToken } = await import('../src/services/auth')

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

test('backup export keeps full decrypted auth (api_key, access_token, custom_auth) and upstream_type', () => {
  const auth = {
    api_key: 'sk-test-secret',
    access_token: 'token-for-balance',
    custom_auth: { header_name: 'X-Custom-Auth', format: 'Token {key}' },
  }
  providers.createProvider({
    name: 'enc-provider',
    protocol: 'openai',
    group_id: null,
    base_url: 'https://example.test',
    auth_json: JSON.stringify(auth),
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
    upstream_type: 'sub2api',
  })

  const exported = backup.exportBackup()
  assert.equal(exported.providers.length, 1)
  assert.deepEqual(exported.providers[0].auth, auth)
  assert.equal(exported.providers[0].upstream_type, 'sub2api')
})

test('backup import stores auth encrypted (plaintext column empty) and preserves upstream_type', () => {
  const auth = { api_key: 'sk-roundtrip', access_token: 'tok' }
  const created = providers.createProvider({
    name: 'roundtrip',
    protocol: 'openai',
    group_id: null,
    base_url: 'https://example.test',
    auth_json: JSON.stringify(auth),
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
    upstream_type: 'newapi',
  })

  const exported = backup.exportBackup()
  backup.importBackup(exported)

  const raw = db.prepare('SELECT auth_json, auth_json_encrypted, upstream_type FROM providers WHERE id = ?').get(created.id) as {
    auth_json: string
    auth_json_encrypted: string | null
    upstream_type: string | null
  }
  assert.equal(raw.auth_json, '', 'plaintext auth column must be empty after import')
  assert.ok(raw.auth_json_encrypted, 'auth must be stored encrypted')
  assert.equal(raw.upstream_type, 'newapi')

  const restored = providers.getProvider(created.id)!
  assert.deepEqual(JSON.parse(restored.auth_json), auth)
})

test('backup import accepts legacy plaintext auth entries and encrypts them', () => {
  const legacy = {
    token: 'any-token',
    settings: {},
    providers: [
      {
        id: 'legacy-provider',
        name: 'legacy',
        protocol: 'openai' as const,
        group_id: null,
        base_url: 'https://legacy.test',
        auth: { api_key: 'sk-legacy' } as Record<string, string | { header_name: string; format: string }>,
        custom_headers: {},
        proxy_url: null,
        timeout_ms: null,
        model_filter: null,
        upstream_type: null,
        enabled: 1 as const,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    provider_groups: [],
    models: [],
    groups: [],
    aliases: [],
  }

  backup.importBackup(legacy)

  const raw = db.prepare('SELECT auth_json, auth_json_encrypted FROM providers WHERE id = ?').get('legacy-provider') as {
    auth_json: string
    auth_json_encrypted: string | null
  }
  assert.equal(raw.auth_json, '')
  assert.ok(raw.auth_json_encrypted)
  assert.deepEqual(JSON.parse(providers.getProvider('legacy-provider')!.auth_json), { api_key: 'sk-legacy' })
})

test('backup round-trip preserves alias routing_config and target weight', () => {
  const created = providers.createProvider({
    name: 'routing-provider',
    protocol: 'openai',
    group_id: null,
    base_url: 'https://example.test',
    auth_json: '{}',
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
  })
  models.addModel({ provider_id: created.id, model_id: 'real-model', display_name: null })
  models.addAlias({
    protocol: 'openai',
    alias_name: 'routing-alias',
    provider_id: created.id,
    model_id: 'real-model',
    routing_config: { mode: 'failover', max_attempts: 2, cooldown_seconds: 30 },
  })
  models.setAliasTargetWeight({ protocol: 'openai', alias_name: 'routing-alias', provider_id: created.id, model_id: 'real-model', weight: 250 })

  const exported = backup.exportBackup()
  backup.importBackup(exported)

  const reexported = backup.exportBackup()
  const alias = reexported.aliases.find((item) => item.alias_name === 'routing-alias')!
  assert.deepEqual(alias.routing_config, { mode: 'failover', max_attempts: 2, cooldown_seconds: 30 })
  assert.equal(alias.targets.find((target) => target.provider_id === created.id)?.weight, 250)
})

test('backup export fails loudly instead of exporting empty auth when a credential cannot be decrypted', async () => {
  const created = providers.createProvider({
    name: 'undecryptable',
    protocol: 'openai',
    group_id: null,
    base_url: 'https://example.test',
    auth_json: JSON.stringify({ api_key: 'sk-undecryptable' }),
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
  })
  assert.deepEqual(backup.exportBackup().providers.find((p) => p.id === created.id)!.auth, { api_key: 'sk-undecryptable' })

  // 模拟 ENCRYPTION_KEY 丢失/更换：密文无法解密，明文列为空
  db.prepare('UPDATE providers SET auth_json = ?, auth_json_encrypted = ? WHERE id = ?').run('', 'ab:cd:ef', created.id)

  assert.throws(() => backup.exportBackup(), /failed to decrypt auth_json/)

  const res = await api.request('http://localhost/backup', {
    headers: { authorization: `Bearer ${getAdminToken()}` },
  })
  assert.equal(res.status, 500)
  const body = await res.json() as { ok: boolean; error: { code: string } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'backup_export_failed')
})
