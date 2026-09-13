import { test } from 'node:test'
import assert from 'node:assert'
import { buildCandidateOrder, selectTarget, parseRoutingConfig, normalizeRoutingConfigInput } from '../src/services/routing'
import type { ModelAliasRow, ModelAliasTargetRow, ProviderProtocol } from '../src/types'

function makeAlias(routingConfigJson: string | null): ModelAliasRow {
  return {
    protocol: 'openai' as ProviderProtocol,
    alias_name: 'test-alias',
    group_id: null,
    enabled: 1,
    thinking_json: null,
    routing_config_json: routingConfigJson,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function makeTarget(id: number, priority: number, active: number, weight = 100): ModelAliasTargetRow {
  return {
    id,
    protocol: 'openai' as ProviderProtocol,
    alias_name: 'test-alias',
    provider_id: `provider-${id}`,
    model_id: `model-${id}`,
    priority,
    active,
    weight,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

// ---------- parseRoutingConfig ----------

test('parseRoutingConfig returns default for null / invalid JSON / unknown mode', () => {
  for (const json of [null, 'not-json', JSON.stringify({ mode: 'unknown' }), JSON.stringify({ mode: 'round-robin' })]) {
    const config = parseRoutingConfig(json)
    assert.strictEqual(config.mode, 'single')
  }
})

test('parseRoutingConfig clamps out-of-range fields', () => {
  const config = parseRoutingConfig(JSON.stringify({ mode: 'failover', max_attempts: 999, cooldown_seconds: -5, affinity_seconds: 99999 }))
  assert.strictEqual(config.max_attempts, 10)
  assert.strictEqual(config.cooldown_seconds, 0)
  assert.strictEqual(config.affinity_seconds, 3600)
})

test('normalizeRoutingConfigInput rejects unknown mode', () => {
  assert.strictEqual(normalizeRoutingConfigInput({ mode: 'round-robin' as never }), null)
  const ok = normalizeRoutingConfigInput({ mode: 'weighted', max_attempts: 3 })
  assert.strictEqual(ok?.mode, 'weighted')
  assert.strictEqual(ok?.max_attempts, 3)
})

// ---------- single ----------

test('single mode returns only the active target', () => {
  const alias = makeAlias(JSON.stringify({ mode: 'single' }))
  const targets = [makeTarget(1, 0, 0), makeTarget(2, 1, 1), makeTarget(3, 2, 0)]
  const order = buildCandidateOrder(alias, targets)
  assert.strictEqual(order.length, 1)
  assert.strictEqual(order[0].id, 2)
})

test('single mode returns empty when no active target', () => {
  const alias = makeAlias(JSON.stringify({ mode: 'single' }))
  const order = buildCandidateOrder(alias, [makeTarget(1, 0, 0), makeTarget(2, 1, 0)])
  assert.strictEqual(order.length, 0)
})

// ---------- weighted ----------

test('weighted mode returns all candidates as ordered list', () => {
  const alias = makeAlias(JSON.stringify({ mode: 'weighted' }))
  const targets = [makeTarget(1, 0, 0, 100), makeTarget(2, 1, 0, 100), makeTarget(3, 2, 0, 100)]
  const order = buildCandidateOrder(alias, targets)
  assert.strictEqual(order.length, 3)
  assert.strictEqual(new Set(order.map((t) => t.id)).size, 3, 'no duplicates')
})

test('weighted mode distributes first pick by weight', () => {
  const alias = makeAlias(JSON.stringify({ mode: 'weighted' }))
  const targets = [makeTarget(1, 0, 0, 100), makeTarget(2, 1, 0, 0), makeTarget(3, 2, 0, 0)]
  const counts = { 1: 0, 2: 0, 3: 0 }
  for (let i = 0; i < 200; i++) {
    const order = buildCandidateOrder(alias, targets)
    counts[order[0].id as keyof typeof counts]++
  }
  assert.strictEqual(counts[1], 200, 'weight-100 target should always be picked first')
  assert.strictEqual(counts[2], 0)
  assert.strictEqual(counts[3], 0)
})

test('weighted mode puts zero-weight targets last but still in the list', () => {
  const alias = makeAlias(JSON.stringify({ mode: 'weighted' }))
  const targets = [makeTarget(1, 0, 0, 0), makeTarget(2, 1, 0, 50), makeTarget(3, 2, 0, 0)]
  for (let i = 0; i < 50; i++) {
    const order = buildCandidateOrder(alias, targets)
    assert.strictEqual(order[order.length - 1].weight, 0, 'zero-weight must be last')
    assert.strictEqual(order[0].id, 2)
  }
})

test('weighted mode with all-zero weights distributes uniformly', () => {
  const alias = makeAlias(JSON.stringify({ mode: 'weighted' }))
  const targets = [makeTarget(1, 0, 0, 0), makeTarget(2, 1, 0, 0)]
  const counts = { 1: 0, 2: 0 }
  for (let i = 0; i < 200; i++) {
    const order = buildCandidateOrder(alias, targets)
    counts[order[0].id as keyof typeof counts]++
  }
  assert.ok(counts[1] > 60 && counts[1] < 140, `uniform-ish distribution expected, got ${counts[1]}/${counts[2]}`)
})

// ---------- failover ----------

test('failover mode returns strict priority order (priority ASC, id ASC)', () => {
  const alias = makeAlias(JSON.stringify({ mode: 'failover' }))
  const targets = [makeTarget(3, 1, 0), makeTarget(1, 0, 0), makeTarget(2, 0, 0)]
  const order = buildCandidateOrder(alias, targets)
  assert.deepStrictEqual(order.map((t) => t.id), [1, 2, 3])
})

// ---------- 兼容 selectTarget ----------

test('selectTarget returns first of candidate order', () => {
  const alias = makeAlias(JSON.stringify({ mode: 'failover' }))
  const targets = [makeTarget(3, 1, 0), makeTarget(1, 0, 0)]
  assert.strictEqual(selectTarget(alias, targets)?.id, 1)
  assert.strictEqual(selectTarget(makeAlias(JSON.stringify({ mode: 'single' })), [makeTarget(1, 0, 0)]), null)
})

test('returns empty for empty targets', () => {
  assert.strictEqual(buildCandidateOrder(makeAlias(null), []).length, 0)
})
