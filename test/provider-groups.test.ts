import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-provider-groups-'))
process.chdir(tempRoot)

const { db } = await import('../src/db/index')
const providers = await import('../src/services/providers')
const models = await import('../src/services/models')
const backup = await import('../src/services/backup')

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

function createProvider(name: string, protocol: 'openai' | 'anthropic', groupId: string | null) {
  return providers.createProvider({
    name,
    protocol,
    group_id: groupId,
    base_url: 'https://example.test',
    auth_json: '{}',
    custom_headers_json: '{}',
    proxy_url: null,
    timeout_ms: null,
    model_filter: null,
  })
}

test('provider groups remain routing-neutral and support atomic group operations and backup restore', () => {
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }
  assert.equal(version.version, 7)

  const openaiGroup = providers.createProviderGroup({ protocol: 'openai', name: 'Production' })
  const anthropicGroup = providers.createProviderGroup({ protocol: 'anthropic', name: 'Production' })
  assert.notEqual(openaiGroup.id, anthropicGroup.id)
  assert.throws(() => providers.createProviderGroup({ protocol: 'openai', name: 'Production' }), /UNIQUE/)
  assert.throws(() => createProvider('Wrong protocol', 'openai', anthropicGroup.id), /FOREIGN KEY/)

  const primary = createProvider('Primary', 'openai', openaiGroup.id)
  const secondary = createProvider('Secondary', 'openai', openaiGroup.id)
  const fallback = createProvider('Fallback', 'openai', null)
  const now = new Date().toISOString()
  const insertModel = db.prepare(
    `INSERT INTO provider_models
      (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
     VALUES (?, ?, NULL, 1, 'manual', ?, ?)`,
  )
  insertModel.run(primary.id, 'model-primary', now, now)
  insertModel.run(secondary.id, 'model-secondary', now, now)
  insertModel.run(fallback.id, 'model-fallback', now, now)
  models.addAlias({ protocol: 'openai', alias_name: 'grouped-route', provider_id: primary.id, model_id: 'model-primary' })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'grouped-route', provider_id: secondary.id, model_id: 'model-secondary' })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'grouped-route', provider_id: fallback.id, model_id: 'model-fallback' })

  const stats = providers.listProviderGroups().find((group) => group.protocol === 'openai' && group.id === openaiGroup.id)
  assert.equal(stats?.provider_count, 2)
  assert.equal(stats?.enabled_count, 2)

  assert.equal(providers.deleteProviderGroup({ protocol: 'openai', id: openaiGroup.id }), 2)
  assert.equal(providers.getProvider(primary.id)?.group_id, null)
  const routeAfterUngroup = models.findRoute('openai', 'grouped-route')
  assert.equal(routeAfterUngroup.kind, 'ok')
  if (routeAfterUngroup.kind === 'ok') assert.equal(routeAfterUngroup.provider.id, primary.id)

  const cleanupGroup = providers.createProviderGroup({ protocol: 'openai', name: 'Cleanup' })
  providers.updateProvider(primary.id, { group_id: cleanupGroup.id })
  providers.updateProvider(secondary.id, { group_id: cleanupGroup.id, enabled: 0 })
  assert.equal(providers.enableGroupProviders({ protocol: 'openai', group_id: cleanupGroup.id }), 1)
  assert.equal(providers.getProvider(secondary.id)?.enabled, 1)
  assert.equal(providers.setGroupProvidersEnabled({ protocol: 'openai', group_id: cleanupGroup.id }, 0), 2)
  assert.equal(providers.getProvider(primary.id)?.enabled, 0)
  assert.equal(providers.getProvider(secondary.id)?.enabled, 0)
  const routeAfterGroupDisable = models.findRoute('openai', 'grouped-route')
  assert.equal(routeAfterGroupDisable.kind, 'ok')
  if (routeAfterGroupDisable.kind === 'ok') assert.equal(routeAfterGroupDisable.provider.id, fallback.id)
  assert.equal(providers.setGroupProvidersEnabled({ protocol: 'openai', group_id: cleanupGroup.id }, 1), 2)
  const routeAfterGroupEnable = models.findRoute('openai', 'grouped-route')
  assert.equal(routeAfterGroupEnable.kind, 'ok')
  if (routeAfterGroupEnable.kind === 'ok') assert.equal(routeAfterGroupEnable.provider.id, fallback.id)

  const exported = backup.exportBackup()
  assert.equal(exported.provider_groups.length, 2)
  assert.equal(exported.providers.find((provider) => provider.id === primary.id)?.group_id, cleanupGroup.id)
  backup.importBackup(exported)
  assert.equal(providers.getProvider(primary.id)?.group_id, cleanupGroup.id)

  assert.equal(providers.deleteGroupProviders({ protocol: 'openai', group_id: cleanupGroup.id }), 2)
  assert.equal(providers.getProvider(primary.id), undefined)
  assert.equal(providers.getProvider(secondary.id), undefined)
  assert.ok(providers.getProviderGroup('openai', cleanupGroup.id))
  assert.equal(providers.listProviderGroups().find((group) => group.id === cleanupGroup.id)?.provider_count, 0)
  const routeAfterBatchDelete = models.findRoute('openai', 'grouped-route')
  assert.equal(routeAfterBatchDelete.kind, 'ok')
  if (routeAfterBatchDelete.kind === 'ok') assert.equal(routeAfterBatchDelete.provider.id, fallback.id)
})
