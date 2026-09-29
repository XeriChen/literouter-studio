import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearKeyPoolState, hasKeyPool, keyPoolStatus, nextKeyRetrySeconds, pickKey, releaseKeyProbe, reportKeyFailure, reportKeySuccess, retryAfterMs } from '../src/services/key-pool'
import type { ProviderRow } from '../src/types'
import { readProviderAuthTokens } from '../src/services/balance/shared'

const provider = {
  id: 'pool-test',
  auth_json: JSON.stringify({ api_keys: [
    { id: 'a', name: 'A', key: 'sk-a', enabled: true },
    { id: 'b', name: 'B', key: 'sk-b', enabled: true },
  ], key_strategy: 'polling' }),
} as ProviderRow

test('polling rotates keys; failed key cools only for its model and gets one recovery probe', () => {
  clearKeyPoolState()
  assert.equal(pickKey(provider, 'm1', new Set(), 1000)?.credential.id, 'a')
  reportKeyFailure(provider.id, 'a', 'm1', 429, 10, {}, 1000)
  assert.equal(pickKey(provider, 'm1', new Set(), 1001)?.credential.id, 'b')
  assert.equal(pickKey(provider, 'm2', new Set(), 1001)?.credential.id, 'a')
  const probe = pickKey(provider, 'm1', new Set(['b']), 11000)
  assert.equal(probe?.credential.id, 'a')
  assert.equal(probe?.isProbe, true)
  assert.equal(pickKey(provider, 'm1', new Set(['b']), 11001), null)
  reportKeySuccess(provider.id, 'a', 'm1')
  assert.equal(pickKey(provider, 'm1', new Set(['b']), 11002)?.isProbe, false)
})

test('polling follows configured order across retries and skipped keys', () => {
  clearKeyPoolState()
  const three = { ...provider, id: 'three-keys', auth_json: JSON.stringify({ api_keys: [
    { id: 'a', name: 'A', key: 'a', enabled: true },
    { id: 'b', name: 'B', key: 'b', enabled: true },
    { id: 'c', name: 'C', key: 'c', enabled: true },
  ] }) } as ProviderRow
  const excluded = new Set<string>()
  for (const expected of ['a', 'b', 'c']) {
    const pick = pickKey(three, 'm', excluded, 1000)
    assert.equal(pick?.credential.id, expected)
    excluded.add(expected)
  }
  assert.equal(pickKey(three, 'm', excluded, 1000), null)
  assert.equal(pickKey(three, 'm', new Set(), 1001)?.credential.id, 'a')
})

test('authentication failure blocks the credential across models', () => {
  clearKeyPoolState()
  reportKeyFailure(provider.id, 'a', 'm1', 401, 60, {}, 1000)
  assert.equal(pickKey(provider, 'm2', new Set(['b']), 1001), null)
})

test('retry estimate uses the earliest available key', () => {
  clearKeyPoolState()
  reportKeyFailure(provider.id, 'a', 'm1', 429, 60, {}, 1000)
  reportKeyFailure(provider.id, 'b', 'm1', 429, 20, {}, 1000)
  assert.equal(nextKeyRetrySeconds(provider, 'm1', 2000), 19)
  assert.equal(nextKeyRetrySeconds(provider, 'm2', 2000), null)
})

test('retry headers accept duration and HTTP date, bounded to one hour', () => {
  const now = Date.UTC(2026, 0, 1)
  assert.equal(retryAfterMs({ 'retry-after': '5' }, now), 5000)
  assert.equal(retryAfterMs({ 'Retry-After': new Date(now + 3000).toUTCString() }, now), 3000)
  assert.equal(retryAfterMs({ 'x-ratelimit-reset': String((now + 7000) / 1000) }, now), 7000)
  assert.equal(retryAfterMs({ 'x-ratelimit-reset-requests': '1m30s' }, now), 90_000)
  assert.equal(retryAfterMs({ 'x-ratelimit-reset-tokens': '500ms' }, now), 500)
  assert.equal(retryAfterMs({ 'retry-after': '999999' }, now), 3_600_000)
})

test('balance reads the first enabled pooled key', () => {
  const auth = JSON.parse(provider.auth_json) as { api_keys: Array<{ enabled: boolean }> }
  auth.api_keys[0]!.enabled = false
  assert.equal(readProviderAuthTokens(JSON.stringify(auth)).apiKey, 'sk-b')
})

test('random and priority strategies respect exclusions and configured order', () => {
  clearKeyPoolState()
  const random = { ...provider, id: 'random-pool', auth_json: JSON.stringify({ api_keys: [
    { id: 'a', name: 'A', key: 'a', enabled: true },
    { id: 'b', name: 'B', key: 'b', enabled: true },
  ], key_strategy: 'random' }) } as ProviderRow
  // 排除后只剩一个候选时，random 也必须命中它
  for (let i = 0; i < 20; i++) {
    assert.equal(pickKey(random, 'm', new Set(['a']), 1000 + i)?.credential.id, 'b')
  }
  const seen = new Set<string>()
  for (let i = 0; i < 200; i++) seen.add(pickKey(random, 'm', new Set(), 2000 + i)!.credential.id)
  assert.deepEqual([...seen].sort(), ['a', 'b'])

  const priority = { ...provider, id: 'priority-pool', auth_json: JSON.stringify({ api_keys: [
    { id: 'a', name: 'A', key: 'a', enabled: true },
    { id: 'b', name: 'B', key: 'b', enabled: true },
  ], key_strategy: 'priority' }) } as ProviderRow
  assert.equal(pickKey(priority, 'm', new Set(), 3000)?.credential.id, 'a')
  assert.equal(pickKey(priority, 'm', new Set(), 3001)?.credential.id, 'a')
  reportKeyFailure(priority.id, 'a', 'm', 429, 60, {}, 3002)
  assert.equal(pickKey(priority, 'm', new Set(), 3003)?.credential.id, 'b')
})

test('empty or fully disabled pools have no pickable key', () => {
  clearKeyPoolState()
  const empty = { ...provider, id: 'empty-pool', auth_json: JSON.stringify({ api_keys: [] }) } as ProviderRow
  assert.equal(hasKeyPool(empty), true)
  assert.equal(pickKey(empty, 'm', new Set(), 1000), null)
  const disabled = { ...provider, id: 'disabled-pool', auth_json: JSON.stringify({ api_keys: [
    { id: 'a', name: 'A', key: 'a', enabled: false },
  ] }) } as ProviderRow
  assert.equal(pickKey(disabled, 'm', new Set(), 1000), null)
  const legacy = { ...provider, id: 'legacy-pool', auth_json: JSON.stringify({ api_key: 'sk-one' }) } as ProviderRow
  assert.equal(hasKeyPool(legacy), false)
})

test('cooldown_seconds 0 keeps keys pickable even with upstream Retry-After', () => {
  clearKeyPoolState()
  reportKeyFailure(provider.id, 'a', 'm1', 429, 0, { 'retry-after': '30' }, 1000)
  assert.equal(pickKey(provider, 'm1', new Set(['b']), 1001)?.credential.id, 'a')
  assert.equal(keyPoolStatus(provider, 1001).every((item) => item.cooldown_until === null), true)
})

test('probe TTL expiry and releaseKeyProbe reopen the recovery slot', () => {
  clearKeyPoolState()
  reportKeyFailure(provider.id, 'a', 'm1', 429, 10, {}, 1000)
  const probe = pickKey(provider, 'm1', new Set(['b']), 11000)
  assert.equal(probe?.isProbe, true)
  assert.equal(pickKey(provider, 'm1', new Set(['b']), 11001), null)
  releaseKeyProbe(provider.id, 'a', 'm1')
  assert.equal(pickKey(provider, 'm1', new Set(['b']), 11002)?.isProbe, true)
  // 探测独占超过 120s 未回传结果时自动过期，允许重新探测
  assert.equal(pickKey(provider, 'm1', new Set(['b']), 11002 + 120_000)?.isProbe, true)
})

test('keyPoolStatus reflects per-key cooldown and clears on success', () => {
  clearKeyPoolState()
  reportKeyFailure(provider.id, 'a', 'm1', 429, 60, {}, 1000)
  assert.deepEqual(keyPoolStatus(provider, 1001), [
    { id: 'a', cooldown_until: 61000 },
    { id: 'b', cooldown_until: null },
  ])
  reportKeySuccess(provider.id, 'a', 'm1')
  assert.deepEqual(keyPoolStatus(provider, 1002), [
    { id: 'a', cooldown_until: null },
    { id: 'b', cooldown_until: null },
  ])
})

test('clearKeyPoolState scoped to one provider leaves other providers untouched', () => {
  clearKeyPoolState()
  const other = { ...provider, id: 'other-pool' } as ProviderRow
  reportKeyFailure(provider.id, 'a', 'm1', 401, 60, {}, 1000)
  reportKeyFailure(other.id, 'a', 'm1', 401, 60, {}, 1000)
  clearKeyPoolState(provider.id)
  assert.equal(pickKey(provider, 'm1', new Set(['b']), 1001)?.credential.id, 'a')
  assert.equal(pickKey(other, 'm1', new Set(['b']), 1001), null)
})
