import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-aliases-'))
process.chdir(tempRoot)

const { db } = await import('../src/db/index')
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

test('initializes schema v5 and keeps exactly one priority-routed active target', () => {
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }
  assert.equal(version.version, 5)

  const now = new Date().toISOString()
  const insertProvider = db.prepare(
    `INSERT INTO providers
      (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, enabled, created_at, updated_at)
     VALUES (?, ?, 'openai', 'https://example.test', '{}', '{}', NULL, NULL, NULL, 1, ?, ?)`,
  )
  const insertModel = db.prepare(
    `INSERT INTO provider_models
      (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
     VALUES (?, ?, NULL, 1, 'manual', ?, ?)`,
  )
  insertProvider.run('p1', 'Provider 1', now, now)
  insertProvider.run('p2', 'Provider 2', now, now)
  insertModel.run('p1', 'model-a', now, now)
  insertModel.run('p2', 'model-b', now, now)

  const group = models.createAliasGroup({ protocol: 'openai', name: 'Production' })
  models.addAlias({
    protocol: 'openai',
    alias_name: 'managed-alias',
    provider_id: 'p1',
    model_id: 'model-a',
    group_id: group.id,
  })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'managed-alias', provider_id: 'p2', model_id: 'model-b' })
  models.reorderAliasTargets({
    protocol: 'openai',
    alias_name: 'managed-alias',
    targets: [
      { provider_id: 'p2', model_id: 'model-b' },
      { provider_id: 'p1', model_id: 'model-a' },
    ],
  })

  const alias = models.listAliases().find((item) => item.alias_name === 'managed-alias')
  assert.equal(alias?.targets.length, 2)
  assert.deepEqual(alias?.targets.map((target) => target.priority), [0, 1])
  assert.equal(alias?.targets.filter((target) => target.active).length, 1)

  models.setModelEnabled({ provider_id: 'p1', model_id: 'model-a', enabled: 0 })
  const switched = models.findRoute('openai', 'managed-alias')
  assert.equal(switched.kind, 'ok')
  if (switched.kind === 'ok') assert.equal(switched.provider.id, 'p2')

  models.setModelEnabled({ provider_id: 'p1', model_id: 'model-a', enabled: 1 })
  const noSwitchBack = models.findRoute('openai', 'managed-alias')
  assert.equal(noSwitchBack.kind, 'ok')
  if (noSwitchBack.kind === 'ok') assert.equal(noSwitchBack.provider.id, 'p2')

  models.updateAlias({ protocol: 'openai', alias_name: 'managed-alias', enabled: 0 })
  assert.equal(models.findRoute('openai', 'managed-alias').kind, 'not_found')
  assert.equal(models.enableGroupAliases({ protocol: 'openai', group_id: group.id }), 1)

  models.deleteAliasTarget({ protocol: 'openai', alias_name: 'managed-alias', provider_id: 'p2', model_id: 'model-b' })
  const fallback = models.findRoute('openai', 'managed-alias')
  assert.equal(fallback.kind, 'ok')
  if (fallback.kind === 'ok') assert.equal(fallback.provider.id, 'p1')

  models.updateAlias({ protocol: 'openai', alias_name: 'managed-alias', new_alias_name: 'renamed-alias' })
  assert.equal(models.findRoute('openai', 'managed-alias').kind, 'not_found')
  assert.equal(models.findRoute('openai', 'renamed-alias').kind, 'ok')

  const exported = backup.exportBackup()
  assert.equal(exported.groups.length, 1)
  assert.equal(exported.aliases[0]?.targets.length, 1)
  backup.importBackup(exported)
  assert.equal(models.findRoute('openai', 'renamed-alias').kind, 'ok')

  assert.equal(models.deleteAliasGroup({ protocol: 'openai', id: group.id }), 1)
  assert.equal(models.getAlias('openai', 'renamed-alias'), undefined)
})
