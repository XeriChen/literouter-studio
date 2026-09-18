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

test('initializes schema v11 and keeps exactly one priority-routed active target', () => {
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }
  assert.equal(version.version, 11)

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
  if (switched.kind === 'ok') assert.equal(switched.candidates.find((c) => c.target.active === 1)?.provider.id, 'p2')

  models.setModelEnabled({ provider_id: 'p1', model_id: 'model-a', enabled: 1 })
  const noSwitchBack = models.findRoute('openai', 'managed-alias')
  assert.equal(noSwitchBack.kind, 'ok')
  if (noSwitchBack.kind === 'ok') assert.equal(noSwitchBack.candidates.find((c) => c.target.active === 1)?.provider.id, 'p2')

  models.updateAlias({ protocol: 'openai', alias_name: 'managed-alias', enabled: 0 })
  assert.equal(models.findRoute('openai', 'managed-alias').kind, 'not_found')
  assert.equal(models.enableGroupAliases({ protocol: 'openai', group_id: group.id }), 1)

  models.deleteAliasTarget({ protocol: 'openai', alias_name: 'managed-alias', provider_id: 'p2', model_id: 'model-b' })
  const fallback = models.findRoute('openai', 'managed-alias')
  assert.equal(fallback.kind, 'ok')
  if (fallback.kind === 'ok') assert.equal(fallback.candidates.find((c) => c.target.active === 1)?.provider.id, 'p1')

  models.updateAlias({ protocol: 'openai', alias_name: 'managed-alias', new_alias_name: 'renamed-alias' })
  assert.equal(models.findRoute('openai', 'managed-alias').kind, 'not_found')
  assert.equal(models.findRoute('openai', 'renamed-alias').kind, 'ok')

  models.addAlias({
    protocol: 'openai',
    alias_name: 'ungrouped-alias',
    provider_id: 'p1',
    model_id: 'model-a',
  })

  const exported = backup.exportBackup()
  assert.equal(exported.groups.length, 1)
  assert.equal(exported.aliases.length, 2)
  backup.importBackup(exported)
  assert.equal(models.findRoute('openai', 'renamed-alias').kind, 'ok')
  assert.equal(models.findRoute('openai', 'ungrouped-alias').kind, 'ok')

  assert.equal(models.deleteAliasGroup({ protocol: 'openai', id: group.id }), 1)
  assert.equal(models.getAlias('openai', 'renamed-alias'), undefined)
})

test('thinking config validates protocol-native values, routes to rewrite, and roundtrips via backup', () => {
  // 校验器：openai 只接受 reasoning_effort 字符串；anthropic 接受 enabled(≥1024)/disabled
  assert.equal(models.validateThinkingValue('openai', 'high'), true)
  assert.equal(models.validateThinkingValue('openai', ''), false)
  assert.equal(models.validateThinkingValue('openai', { type: 'enabled' }), false)
  assert.equal(models.validateThinkingValue('anthropic', { type: 'enabled', budget_tokens: 2048 }), true)
  assert.equal(models.validateThinkingValue('anthropic', { type: 'enabled', budget_tokens: 512 }), false)
  assert.equal(models.validateThinkingValue('anthropic', { type: 'disabled' }), true)
  assert.equal(models.validateThinkingValue('anthropic', { type: 'other' }), false)

  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO providers (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, enabled, created_at, updated_at)
     VALUES ('pt1', 'Anthropic Provider', 'anthropic', 'https://anthropic.test', '{}', '{}', NULL, NULL, NULL, 1, ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
     VALUES ('pt1', 'claude-x', NULL, 1, 'manual', ?, ?)`,
  ).run(now, now)

  models.addAlias({
    protocol: 'anthropic',
    alias_name: 'thinking-alias',
    provider_id: 'pt1',
    model_id: 'claude-x',
    thinking: { mode: 'override', value: { type: 'enabled', budget_tokens: 2048 } },
  })
  assert.deepEqual(models.getAlias('anthropic', 'thinking-alias')?.thinking_json, '{"mode":"override","value":{"type":"enabled","budget_tokens":2048}}')
  assert.equal(models.listAliases().find((item) => item.alias_name === 'thinking-alias')?.thinking_json !== null, true)

  const route = models.findRoute('anthropic', 'thinking-alias')
  assert.equal(route.kind, 'ok')
  if (route.kind === 'ok') {
    assert.equal(route.thinking?.key, 'thinking')
    assert.equal(route.thinking?.mode, 'override')
    assert.deepEqual(route.thinking?.value, { type: 'enabled', budget_tokens: 2048 })
  }

  // PATCH：改为 default 模式；传 null 清除
  models.updateAlias({ protocol: 'anthropic', alias_name: 'thinking-alias', thinking: { mode: 'default', value: { type: 'disabled' } } })
  const defaulted = models.findRoute('anthropic', 'thinking-alias')
  assert.equal(defaulted.kind, 'ok')
  if (defaulted.kind === 'ok') assert.deepEqual(defaulted.thinking, { key: 'thinking', mode: 'default', value: { type: 'disabled' } })

  // 备份导出/导入保留思考配置
  const exported = backup.exportBackup()
  const exportedAlias = exported.aliases.find((item) => item.alias_name === 'thinking-alias')
  assert.deepEqual(exportedAlias?.thinking, { mode: 'default', value: { type: 'disabled' } })
  backup.importBackup(exported)
  assert.deepEqual(exportedAlias, backup.exportBackup().aliases.find((item) => item.alias_name === 'thinking-alias'))

  models.updateAlias({ protocol: 'anthropic', alias_name: 'thinking-alias', thinking: null })
  const cleared = models.findRoute('anthropic', 'thinking-alias')
  assert.equal(cleared.kind, 'ok')
  if (cleared.kind === 'ok') assert.equal(cleared.thinking, null)

  // 损坏/非法配置按纯透传处理
  assert.equal(models.parseThinkingRewrite('openai', null), null)
  assert.equal(models.parseThinkingRewrite('openai', 'not-json'), null)
  assert.equal(models.parseThinkingRewrite('openai', '{"mode":"other","value":"high"}'), null)
  assert.deepEqual(models.parseThinkingRewrite('openai', '{"mode":"override","value":"high"}'), { key: 'reasoning_effort', mode: 'override', value: 'high' })

  // value 形状必须符合协议，否则同样放弃改写（不得注入非法值）
  assert.equal(models.parseThinkingRewrite('openai', '{"mode":"override"}'), null)
  assert.equal(models.parseThinkingRewrite('openai', '{"mode":"override","value":""}'), null)
  assert.equal(models.parseThinkingRewrite('openai', '{"mode":"override","value":123}'), null)
  assert.equal(models.parseThinkingRewrite('anthropic', '{"mode":"override","value":{"type":"enabled","budget_tokens":512}}'), null)
  assert.equal(models.parseThinkingRewrite('anthropic', '{"mode":"override","value":{"type":"other"}}'), null)
  assert.equal(models.parseThinkingRewrite('anthropic', '{"mode":"override","value":null}'), null)
  assert.equal(models.parseThinkingRewrite('openai', '[]'), null)
  assert.equal(models.parseThinkingRewrite('openai', '"high"'), null)
  assert.deepEqual(
    models.parseThinkingRewrite('anthropic', '{"mode":"default","value":{"type":"enabled","budget_tokens":2048}}'),
    { key: 'thinking', mode: 'default', value: { type: 'enabled', budget_tokens: 2048 } },
  )

  models.deleteAlias({ protocol: 'anthropic', alias_name: 'thinking-alias' })

})

test('merges alias candidates into a new or existing alias without switching traffic', () => {
  const now = new Date().toISOString()
  const insertProvider = db.prepare(
    `INSERT INTO providers
      (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'https://example.test', '{}', '{}', NULL, NULL, NULL, 1, ?, ?)`,
  )
  const insertModel = db.prepare(
    `INSERT INTO provider_models
      (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
     VALUES (?, ?, NULL, 1, 'manual', ?, ?)`,
  )
  insertProvider.run('mp1', 'Merge P1', 'openai', now, now)
  insertProvider.run('mp2', 'Merge P2', 'openai', now, now)
  insertProvider.run('mp3', 'Merge P3', 'openai', now, now)
  insertModel.run('mp1', 'mm1', now, now)
  insertModel.run('mp2', 'mm2', now, now)
  insertModel.run('mp3', 'mm3', now, now)

  // merge-a: mp1/mm1(active) + mp2/mm2；merge-b: mp2/mm2(active) + mp3/mm3
  models.addAlias({ protocol: 'openai', alias_name: 'merge-a', provider_id: 'mp1', model_id: 'mm1' })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'merge-a', provider_id: 'mp2', model_id: 'mm2' })
  models.addAlias({ protocol: 'openai', alias_name: 'merge-b', provider_id: 'mp2', model_id: 'mm2' })
  models.addAliasTarget({ protocol: 'openai', alias_name: 'merge-b', provider_id: 'mp3', model_id: 'mm3' })

  // 1. 合并到新映射：按 (provider, model) 去重跳过，priority 连续，active 取自第一个源
  const created = models.mergeAliases({ protocol: 'openai', sources: ['merge-a', 'merge-b'], target_alias_name: 'merged-new' })
  assert.equal(created.created, true)
  assert.equal(created.added, 3)
  assert.equal(created.skipped, 1)
  const merged = models.listAliases().find((item) => item.alias_name === 'merged-new')
  assert.deepEqual(merged?.targets.map((target) => target.priority), [0, 1, 2])
  assert.equal(merged?.targets.filter((target) => target.active).length, 1)
  const activeTarget = merged?.targets.find((target) => target.active)
  assert.equal(activeTarget?.provider_id, 'mp1')
  assert.equal(activeTarget?.model_id, 'mm1')
  const route = models.findRoute('openai', 'merged-new')
  assert.equal(route.kind, 'ok')
  if (route.kind === 'ok') assert.equal(route.candidates[0]?.provider.id, 'mp1')

  // 2. 并入已有映射：不改其 active（不切流量），只追加缺失候选
  models.addAlias({ protocol: 'openai', alias_name: 'merge-dest', provider_id: 'mp3', model_id: 'mm3' })
  const appended = models.mergeAliases({ protocol: 'openai', sources: ['merge-a', 'merge-b'], target_alias_name: 'merge-dest' })
  assert.equal(appended.created, false)
  assert.equal(appended.added, 2)
  assert.equal(appended.skipped, 2)
  const dest = models.listAliases().find((item) => item.alias_name === 'merge-dest')
  assert.equal(dest?.targets.filter((target) => target.active).length, 1)
  assert.deepEqual(dest?.targets.find((target) => target.active)?.model_id, 'mm3')
  const destRoute = models.findRoute('openai', 'merge-dest')
  assert.equal(destRoute.kind, 'ok')
  if (destRoute.kind === 'ok') assert.equal(destRoute.candidates.find((c) => c.target.active === 1)?.provider.id, 'mp3')

  // 3. 新建时 thinking 继承 sources 顺序上第一个非空配置
  models.addAlias({ protocol: 'openai', alias_name: 'merge-c', provider_id: 'mp1', model_id: 'mm1' })
  models.updateAlias({ protocol: 'openai', alias_name: 'merge-c', thinking: { mode: 'override', value: 'high' } })
  models.addAlias({ protocol: 'openai', alias_name: 'merge-e', provider_id: 'mp1', model_id: 'mm1' })
  models.updateAlias({ protocol: 'openai', alias_name: 'merge-e', thinking: { mode: 'override', value: 'low' } })
  const inherited = models.getAlias('openai', 'merge-c')?.thinking_json ?? null
  models.mergeAliases({ protocol: 'openai', sources: ['merge-a', 'merge-c'], target_alias_name: 'merged-think' })
  assert.equal(models.getAlias('openai', 'merged-think')?.thinking_json, inherited)
  models.mergeAliases({ protocol: 'openai', sources: ['merge-c', 'merge-e'], target_alias_name: 'merged-think-2' })
  assert.equal(models.getAlias('openai', 'merged-think-2')?.thinking_json, inherited)

  // 4. delete_sources：删除源映射，目标与候选保留
  const withDelete = models.mergeAliases({
    protocol: 'openai',
    sources: ['merge-a', 'merge-b'],
    target_alias_name: 'merged-delete',
    delete_sources: true,
  })
  assert.equal(withDelete.deleted, 2)
  assert.equal(models.getAlias('openai', 'merge-a'), undefined)
  assert.equal(models.getAlias('openai', 'merge-b'), undefined)
  assert.equal(models.listAliases().find((item) => item.alias_name === 'merged-delete')?.targets.length, 3)

  // 5. 源即目标 / 源不存在 / 跨协议 → 直接抛错
  assert.throws(
    () => models.mergeAliases({ protocol: 'openai', sources: ['merged-new'], target_alias_name: 'merged-new' }),
    /no source aliases/,
  )
  assert.throws(
    () => models.mergeAliases({ protocol: 'openai', sources: ['nope'], target_alias_name: 'merged-x' }),
    /alias not found/,
  )
  assert.throws(
    () => models.mergeAliases({ protocol: 'anthropic', sources: ['merged-new'], target_alias_name: 'merged-y' }),
    /alias not found/,
  )

  // 6. 备份往返保留合并结果
  const snapshot = backup.exportBackup()
  backup.importBackup(snapshot)
  assert.equal(models.findRoute('openai', 'merged-new').kind, 'ok')
  assert.equal(models.listAliases().find((item) => item.alias_name === 'merged-new')?.targets.length, 3)
})

test('creates a target-less empty alias and routes after the first target is added', () => {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO providers (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, model_filter, enabled, created_at, updated_at)
     VALUES ('ep1', 'Empty P1', 'openai', 'https://example.test', '{}', '{}', NULL, NULL, NULL, 1, ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO provider_models (provider_id, model_id, display_name, enabled, source, created_at, updated_at)
     VALUES ('ep1', 'em1', NULL, 1, 'manual', ?, ?)`,
  ).run(now, now)

  const group = models.createAliasGroup({ protocol: 'openai', name: 'Placeholder' })
  const row = models.addAlias({ protocol: 'openai', alias_name: 'empty-alias', group_id: group.id })
  assert.equal(row.group_id, group.id)

  // 空映射：零候选、不可路由（存在但无可用候选 → provider_disabled）
  const listed = models.listAliases().find((item) => item.alias_name === 'empty-alias')
  assert.equal(listed?.targets.length, 0)
  assert.equal(models.findRoute('openai', 'empty-alias').kind, 'provider_disabled')

  // 补上首个候选后自动 active，立即可路由
  models.addAliasTarget({ protocol: 'openai', alias_name: 'empty-alias', provider_id: 'ep1', model_id: 'em1' })
  const withTarget = models.listAliases().find((item) => item.alias_name === 'empty-alias')
  assert.equal(withTarget?.targets.length, 1)
  assert.equal(withTarget?.targets[0]?.active, 1)
  const routed = models.findRoute('openai', 'empty-alias')
  assert.equal(routed.kind, 'ok')
  if (routed.kind === 'ok') assert.equal(routed.candidates[0]?.provider.id, 'ep1')
})
