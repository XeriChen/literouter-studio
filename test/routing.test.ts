import { test } from 'node:test'
import assert from 'node:assert'
import { selectTarget, parseRoutingConfig } from '../src/services/routing'
import type { ModelAliasRow, ModelAliasTargetRow, ProviderProtocol } from '../src/types'

function makeAlias(mode: 'single' | 'weighted' | 'failover', routingConfigJson: string | null = null): ModelAliasRow {
  return {
    protocol: 'openai' as ProviderProtocol,
    alias_name: 'test-alias',
    group_id: null,
    enabled: 1,
    thinking_json: null,
    routing_config_json: routingConfigJson ?? JSON.stringify({ mode }),
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

test('parseRoutingConfig returns default for null', () => {
  const config = parseRoutingConfig(null)
  assert.strictEqual(config.mode, 'single')
})

test('parseRoutingConfig returns default for invalid JSON', () => {
  const config = parseRoutingConfig('not-json')
  assert.strictEqual(config.mode, 'single')
})

test('parseRoutingConfig parses valid config', () => {
  const config = parseRoutingConfig(JSON.stringify({ mode: 'weighted', affinity_seconds: 300 }))
  assert.strictEqual(config.mode, 'weighted')
  assert.strictEqual(config.affinity_seconds, 300)
})

test('single mode returns active target', () => {
  const alias = makeAlias('single')
  const targets = [
    makeTarget(1, 0, 0),
    makeTarget(2, 1, 1),
    makeTarget(3, 2, 0),
  ]
  const selected = selectTarget(alias, targets)
  assert.strictEqual(selected?.id, 2)
})

test('single mode returns null when no active target', () => {
  const alias = makeAlias('single')
  const targets = [makeTarget(1, 0, 0), makeTarget(2, 1, 0)]
  const selected = selectTarget(alias, targets)
  assert.strictEqual(selected, null)
})

test('weighted mode distributes by weight', () => {
  const alias = makeAlias('weighted')
  const targets = [
    makeTarget(1, 0, 0, 100),
    makeTarget(2, 1, 0, 0),
    makeTarget(3, 2, 0, 0),
  ]
  const counts = { 1: 0, 2: 0, 3: 0 }
  for (let i = 0; i < 100; i++) {
    const selected = selectTarget(alias, targets)
    if (selected) counts[selected.id as keyof typeof counts]++
  }
  assert.strictEqual(counts[1], 100, 'target with weight 100 should be selected every time')
  assert.strictEqual(counts[2], 0, 'target with weight 0 should never be selected')
  assert.strictEqual(counts[3], 0, 'target with weight 0 should never be selected')
})

test('weighted mode handles zero total weight', () => {
  const alias = makeAlias('weighted')
  const targets = [
    makeTarget(1, 0, 0, 0),
    makeTarget(2, 1, 0, 0),
  ]
  const selected = selectTarget(alias, targets)
  assert.ok(selected)
  assert.strictEqual(selected.id, 1)
})

test('failover mode returns lowest priority', () => {
  const alias = makeAlias('failover')
  const targets = [
    makeTarget(1, 2, 0),
    makeTarget(2, 0, 0),
    makeTarget(3, 1, 0),
  ]
  const selected = selectTarget(alias, targets)
  assert.strictEqual(selected?.id, 2)
})

test('failover mode uses id as tiebreaker', () => {
  const alias = makeAlias('failover')
  const targets = [
    makeTarget(3, 0, 0),
    makeTarget(1, 0, 0),
    makeTarget(2, 0, 0),
  ]
  const selected = selectTarget(alias, targets)
  assert.strictEqual(selected?.id, 1)
})

test('returns null for empty targets', () => {
  const alias = makeAlias('single')
  const selected = selectTarget(alias, [])
  assert.strictEqual(selected, null)
})

test('defaults to single mode for unknown mode', () => {
  const alias = makeAlias('single', JSON.stringify({ mode: 'unknown' }))
  const targets = [
    makeTarget(1, 0, 0),
    makeTarget(2, 1, 1),
  ]
  const selected = selectTarget(alias, targets)
  assert.strictEqual(selected?.id, 2)
})
