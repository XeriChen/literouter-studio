import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-import-'))
process.chdir(tempRoot)

const { db } = await import('../src/db/index')
const models = await import('../src/services/models')
const providers = await import('../src/services/providers')

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

const now = new Date().toISOString()
db.prepare(
  `INSERT INTO providers
    (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, enabled, created_at, updated_at)
   VALUES (?, ?, 'openai', 'https://example.test', '{}', '{}', NULL, NULL, NULL, 1, ?, ?)`,
).run('p-fetch', 'Provider Fetch', now, now)

const modelExists = db.prepare('SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?')

function aliasTargets(aliasName: string) {
  return models.listAliases().find((item) => item.alias_name === aliasName)?.targets ?? []
}

test('导入默认创建同名映射', () => {
  const result = models.importModels('p-fetch', ['imported-with-alias'])
  assert.deepEqual(result, { added: 1, updated: 0 })
  assert.equal(modelExists.get('p-fetch', 'imported-with-alias') !== undefined, true)
  assert.equal(models.getAlias('openai', 'imported-with-alias')?.alias_name, 'imported-with-alias')
  assert.deepEqual(aliasTargets('imported-with-alias').map((target) => target.model_id), ['imported-with-alias'])
})

test('create_alias=false 只登记模型，不创建同名映射', () => {
  const result = providers.importModels('p-fetch', ['imported-no-alias'], { createAlias: false })
  assert.deepEqual(result, { added: 1, updated: 0 })
  assert.equal(modelExists.get('p-fetch', 'imported-no-alias') !== undefined, true)
  assert.equal(models.getAlias('openai', 'imported-no-alias'), undefined)
  assert.equal(aliasTargets('imported-no-alias').length, 0)
})

test('create_alias=false 不会给已有同名映射追加候选', () => {
  models.addAlias({ protocol: 'openai', alias_name: 'existing-alias', provider_id: 'p-fetch', model_id: 'imported-with-alias' })
  const before = aliasTargets('existing-alias').length
  assert.equal(before, 1)

  providers.importModels('p-fetch', ['existing-alias'], { createAlias: false })

  const targets = aliasTargets('existing-alias')
  assert.equal(targets.length, before)
  assert.equal(targets.some((target) => target.model_id === 'existing-alias'), false)
  assert.equal(modelExists.get('p-fetch', 'existing-alias') !== undefined, true)
})

test('一键清理只删除拉取导入模型，保留手动添加与其他 Provider 的模型', () => {
  // 此前用例已在 p-fetch 留下 3 个 fetched：imported-with-alias / imported-no-alias / existing-alias
  models.addModel({ provider_id: 'p-fetch', model_id: 'cleanup-manual', display_name: null })
  db.prepare(
    `INSERT INTO providers
      (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, enabled, created_at, updated_at)
     VALUES (?, ?, 'openai', 'https://example.test', '{}', '{}', NULL, NULL, NULL, 1, ?, ?)`,
  ).run('p-other', 'Provider Other', now, now)
  providers.importModels('p-other', ['cleanup-cross'])
  providers.importModels('p-fetch', ['cleanup-cross'])

  const deleted = models.cleanupImportedModels('p-fetch')
  assert.equal(deleted, 4)
  assert.equal(modelExists.get('p-fetch', 'cleanup-cross'), undefined)
  assert.equal(modelExists.get('p-fetch', 'cleanup-manual') !== undefined, true)
  assert.equal(modelExists.get('p-other', 'cleanup-cross') !== undefined, true)
  assert.equal(models.cleanupImportedModels('p-nonexistent'), 0)
})

test('清理后同名映射候选随引用修复，可重新导入', () => {
  // imported-with-alias 的同名映射在清理后无候选目标
  assert.equal(aliasTargets('imported-with-alias').length, 0)
  const result = models.importModels('p-fetch', ['imported-with-alias'])
  assert.deepEqual(result, { added: 1, updated: 0 })
  assert.deepEqual(aliasTargets('imported-with-alias').map((target) => target.model_id), ['imported-with-alias'])
  assert.equal(aliasTargets('imported-with-alias')[0]?.active, 1)
})

test('清理 active 目标后按优先级切换到可用候选', () => {
  providers.importModels('p-fetch', ['cleanup-cross'])
  models.addAlias({ protocol: 'openai', alias_name: 'cleanup-multi', provider_id: 'p-fetch', model_id: 'cleanup-cross' })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'cleanup-multi', provider_id: 'p-other', model_id: 'cleanup-cross' })
  assert.equal(aliasTargets('cleanup-multi').length, 2)

  const deleted = models.cleanupImportedModels('p-fetch')
  // 此刻 p-fetch 的 fetched 仅剩 imported-with-alias（上一用例重新导入）与 cleanup-cross
  assert.equal(deleted, 2)
  assert.equal(modelExists.get('p-fetch', 'cleanup-cross'), undefined)
  const targets = aliasTargets('cleanup-multi')
  assert.deepEqual(targets.map((target) => `${target.provider_id}/${target.model_id}`), ['p-other/cleanup-cross'])
  assert.equal(targets[0]?.active, 1)
})
