import { test } from 'node:test'
import assert from 'node:assert'
import {
  pickCandidate,
  reportSuccess,
  reportFailure,
  reportClientCancel,
  getHealthSnapshot,
  clearHealthState,
} from '../src/services/health'
import type { RoutingConfig } from '../src/services/routing'

function target(id: number) {
  return { id, provider_id: `p-${id}`, model_id: 'm' }
}

const BASE = 1_000_000_000
const failover: RoutingConfig = { mode: 'failover', cooldown_seconds: 60, max_attempts: 1 }

test('pickCandidate skips cooled-down candidates in order', () => {
  clearHealthState('a1')
  // 预热：target 1 失败 1 次（threshold=1）→ 进入冷却
  reportFailure('a1', 1, failover, BASE)
  const picked = pickCandidate('a1', [target(1), target(2)], failover, BASE + 1)
  assert.ok(picked)
  assert.strictEqual(picked.target.id, 2)
  assert.strictEqual(picked.isProbe, false)
})

test('all cooling down: exactly one probe is granted, others rejected', () => {
  clearHealthState('a2')
  reportFailure('a2', 1, failover, BASE)
  reportFailure('a2', 2, failover, BASE)  // 同时失败，同时进入60秒冷却
  // 冷却未到期：所有请求拒绝
  const tooEarly = pickCandidate('a2', [target(1), target(2)], failover, BASE + 2000)
  assert.strictEqual(tooEarly, null, 'all cooling: no probe until earliest expires')
  // 冷却到期后：首个请求获得探测权
  const first = pickCandidate('a2', [target(1), target(2)], failover, BASE + 60_001)
  assert.ok(first)
  assert.strictEqual(first.isProbe, true)
  assert.strictEqual(first.target.id, 1, 'earliest-expiring candidate probes first')
  const second = pickCandidate('a2', [target(1), target(2)], failover, BASE + 60_002)
  assert.strictEqual(second, null, 'no second probe while one is in flight')
})

test('probe success clears cooldown and probe slot', () => {
  clearHealthState('a3')
  reportFailure('a3', 1, failover, BASE)
  // 冷却到期后才能探测
  const probe = pickCandidate('a3', [target(1)], failover, BASE + 60_001)
  assert.ok(probe?.isProbe)
  reportSuccess('a3', 1, failover, { now: BASE + 60_002 })
  const snap = getHealthSnapshot('a3', BASE + 60_003)
  assert.strictEqual(snap.cooldowns.length, 0)
  assert.strictEqual(snap.probe, null)
  const picked = pickCandidate('a3', [target(1)], failover, BASE + 60_004)
  assert.ok(picked)
  assert.strictEqual(picked.isProbe, false)
})

test('probe slot auto-releases after TTL so a new probe can be granted', () => {
  clearHealthState('a4')
  const config: RoutingConfig = { mode: 'failover', cooldown_seconds: 3600, max_attempts: 1 }
  reportFailure('a4', 1, config, BASE)
  // 冷却到期后首次探测
  const first = pickCandidate('a4', [target(1)], config, BASE + 3600_001)
  assert.ok(first?.isProbe)
  // 探测请求既不成功也不取消（如进程内悬挂），TTL 过后应可再次探测
  const later = pickCandidate('a4', [target(1)], config, BASE + 3600_001 + 121_000)
  assert.ok(later)
  assert.strictEqual(later.isProbe, true)
})

test('client cancel releases the probe slot without counting failure', () => {
  clearHealthState('a5')
  reportFailure('a5', 1, failover, BASE)
  // 冷却到期后探测
  const probe = pickCandidate('a5', [target(1)], failover, BASE + 60_000)
  assert.ok(probe?.isProbe)
  reportClientCancel('a5', 1)
  // 取消后探测位释放，但冷却期未被延长（仍在 BASE + 60_000 到期）
  const snap = getHealthSnapshot('a5', BASE + 59_999)
  assert.strictEqual(snap.probe, null, 'probe slot released')
  assert.strictEqual(snap.cooldowns.length, 1, 'cooldown not extended by cancel')
  assert.strictEqual(snap.cooldowns[0].until, BASE + 60_000, 'cooldown expiry unchanged')
  // 冷却到期后可立即再次探测
  const again = pickCandidate('a5', [target(1)], failover, BASE + 60_000)
  assert.ok(again?.isProbe)
})

test('first failure immediately cools down (threshold = 1)', () => {
  clearHealthState('a6')
  const config: RoutingConfig = { mode: 'failover', cooldown_seconds: 60, max_attempts: 3 }
  // 首次失败立即进入冷却
  reportFailure('a6', 1, config, BASE)
  const snap = getHealthSnapshot('a6', BASE + 1)
  assert.strictEqual(snap.cooldowns.length, 1)
  assert.strictEqual(snap.cooldowns[0].target_id, 1)
  assert.strictEqual(snap.cooldowns[0].until, BASE + 60_000)
  // 冷却未到期：拒绝所有请求
  const tooEarly = pickCandidate('a6', [target(1)], config, BASE + 2)
  assert.strictEqual(tooEarly, null)
  // 冷却刚好到期：可探测
  const probe = pickCandidate('a6', [target(1)], config, BASE + 60_000)
  assert.ok(probe?.isProbe)
})

test('cooldown_seconds = 0 disables cooldown (failover within request still works)', () => {
  clearHealthState('a7')
  const config: RoutingConfig = { mode: 'failover', cooldown_seconds: 0, max_attempts: 1 }
  reportFailure('a7', 1, config, BASE)
  const picked = pickCandidate('a7', [target(1)], config, BASE + 1)
  assert.ok(picked, 'no cooldown applied')
})

test('affinity pins traffic to the target only after armAffinity', () => {
  clearHealthState('a8')
  const config: RoutingConfig = { mode: 'failover', affinity_seconds: 300 }
  // 普通成功不进入亲和
  reportSuccess('a8', 1, config, { now: BASE })
  let picked = pickCandidate('a8', [target(1), target(2)], config, BASE + 1)
  assert.strictEqual(picked?.target.id, 1, 'without affinity, first in order wins')

  // 故障切换后的成功进入亲和
  reportFailure('a8', 1, config, BASE + 2)
  picked = pickCandidate('a8', [target(1), target(2)], config, BASE + 3)
  assert.strictEqual(picked?.target.id, 2, 'cooled target skipped')
  reportSuccess('a8', 2, config, { armAffinity: true, now: BASE + 4 })
  picked = pickCandidate('a8', [target(1), target(2)], config, BASE + 5)
  assert.strictEqual(picked?.target.id, 2, 'affinity pins to recovered target')
  picked = pickCandidate('a8', [target(1), target(2)], config, BASE + 300_005)
  assert.strictEqual(picked?.target.id, 1, 'affinity expires')
})

test('affinity target failure clears affinity', () => {
  clearHealthState('a9')
  const config: RoutingConfig = { mode: 'failover', affinity_seconds: 300, cooldown_seconds: 60 }
  reportFailure('a9', 1, config, BASE)
  reportSuccess('a9', 2, config, { armAffinity: true, now: BASE + 1 })
  reportFailure('a9', 2, config, BASE + 2)
  const snap = getHealthSnapshot('a9', BASE + 3)
  assert.strictEqual(snap.affinity, null, 'affinity cleared by failure')
  // 两个都冷却中：target 1 到期 BASE + 60_000，target 2 到期 BASE + 62_000
  // 冷却期内所有请求返回 null
  const beforeExpiry = pickCandidate('a9', [target(1), target(2)], config, BASE + 59_999)
  assert.strictEqual(beforeExpiry, null, 'all cooling, cannot probe yet')
  // target 1 冷却到期后可探测
  const atExpiry = pickCandidate('a9', [target(1), target(2)], config, BASE + 60_000)
  assert.ok(atExpiry, 'target 1 cooldown expired, probe allowed')
  assert.strictEqual(atExpiry.target.id, 1, 'target 1 failed earlier, probes first')
  assert.strictEqual(atExpiry.isProbe, true)
})

test('success clears failure count and cooldown', () => {
  clearHealthState('a10')
  const config: RoutingConfig = { mode: 'failover', cooldown_seconds: 60 }
  // 失败进入冷却
  reportFailure('a10', 1, config, BASE)
  const snap1 = getHealthSnapshot('a10', BASE + 1)
  assert.strictEqual(snap1.cooldowns.length, 1, 'target cooled after failure')
  assert.strictEqual(snap1.cooldowns[0].target_id, 1)
  assert.strictEqual(snap1.cooldowns[0].until, BASE + 60_000)
  // 冷却到期后探测成功，清除冷却和失败计数
  reportSuccess('a10', 1, config, { now: BASE + 60_000 })
  const snap2 = getHealthSnapshot('a10', BASE + 60_001)
  assert.strictEqual(snap2.cooldowns.length, 0, 'cooldown cleared by success')
  // 后续请求正常路由
  const picked = pickCandidate('a10', [target(1)], config, BASE + 60_002)
  assert.ok(picked, 'target available after successful probe')
  assert.strictEqual(picked.target.id, 1)
  assert.strictEqual(picked.isProbe, false)
})

test('unknown alias key is safe to report on', () => {
  assert.doesNotThrow(() => reportSuccess('nope', 1, failover))
  assert.doesNotThrow(() => reportFailure('nope', 1, failover))
  assert.doesNotThrow(() => reportClientCancel('nope', 1))
})

test('pickCandidate returns null for empty candidates', () => {
  clearHealthState('a11')
  assert.strictEqual(pickCandidate('a11', [], failover, BASE), null)
})
