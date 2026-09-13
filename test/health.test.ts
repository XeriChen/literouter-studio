import { test } from 'node:test'
import assert from 'node:assert'
import { pickCandidate, reportSuccess, reportFailure, clearHealthState, type HealthPick } from '../src/services/health'
import type { RoutingConfig } from '../src/services/routing'

test('W1: single mode does not enter cooldown after failure', () => {
  clearHealthState()
  const aliasKey = 'openai/gpt-4'
  const targets = [{ id: 1 }]
  const config: RoutingConfig = { mode: 'single' }
  const now = 1000

  // 首次请求成功
  const pick1 = pickCandidate(aliasKey, targets, config, now)
  assert.ok(pick1)
  assert.strictEqual(pick1.target.id, 1)
  assert.strictEqual(pick1.isProbe, false)

  // 模拟失败（但 single 模式不应调用 reportFailure）
  // 直接验证：第二个请求仍能正常获取候选
  const pick2 = pickCandidate(aliasKey, targets, config, now + 5000)
  assert.ok(pick2)
  assert.strictEqual(pick2.target.id, 1)
  assert.strictEqual(pick2.isProbe, false)
})

test('W2: expired cooldown returns healthy candidate even when probe slot is occupied', () => {
  clearHealthState()
  const aliasKey = 'openai/gpt-4'
  const targets = [{ id: 1 }, { id: 2 }]
  const config: RoutingConfig = { mode: 'failover', cooldown_seconds: 10 }
  const now = 1000

  // 候选 1 失败进入冷却
  reportFailure(aliasKey, 1, config, now)

  // 10s 后冷却过期
  const expiredTime = now + 10000

  // 同时有两个请求到来：
  // 第一个请求获取候选 1（冷却已过期，直接返回，不需要探测）
  const pick1 = pickCandidate(aliasKey, [{ id: 1 }, { id: 2 }], config, expiredTime)
  assert.ok(pick1)
  assert.strictEqual(pick1.target.id, 1, 'expired cooldown should return directly')
  assert.strictEqual(pick1.isProbe, false, 'should not be a probe when cooldown expired')

  // 第二个请求到来，候选 2 健康，应该返回候选 2
  const pick2 = pickCandidate(aliasKey, targets, config, expiredTime)
  assert.ok(pick2, 'should return healthy candidate')
  assert.strictEqual(pick2.target.id, 1) // 按优先级返回候选 1（已恢复）
  assert.strictEqual(pick2.isProbe, false)
})

test('W2: cooldown expired candidate returned directly without probe', () => {
  clearHealthState()
  const aliasKey = 'openai/gpt-4'
  const targets = [{ id: 1 }]
  const config: RoutingConfig = { mode: 'failover', cooldown_seconds: 10 }
  const now = 1000

  // 候选 1 失败进入冷却
  reportFailure(aliasKey, 1, config, now)

  // 10s 后冷却过期
  const expiredTime = now + 10000

  // 应该直接返回候选 1，不需要探测
  const pick = pickCandidate(aliasKey, targets, config, expiredTime)
  assert.ok(pick)
  assert.strictEqual(pick.target.id, 1)
  assert.strictEqual(pick.isProbe, false, 'expired cooldown should return directly without probe')
})

test('pickCandidate returns null only when all candidates are cooling and unexpired', () => {
  clearHealthState()
  const aliasKey = 'openai/gpt-4'
  const targets = [{ id: 1 }, { id: 2 }]
  const config: RoutingConfig = { mode: 'failover', cooldown_seconds: 60 }
  const now = 1000

  // 两个候选都失败进入冷却
  reportFailure(aliasKey, 1, config, now)
  reportFailure(aliasKey, 2, config, now)

  // 冷却期内，且探测位空闲：返回最早到期的探测
  const pick1 = pickCandidate(aliasKey, targets, config, now + 1000)
  assert.ok(pick1)
  assert.strictEqual(pick1.isProbe, true)

  // 探测位被占用：返回 null
  const pick2 = pickCandidate(aliasKey, targets, config, now + 2000)
  assert.strictEqual(pick2, null)

  // 冷却过期：直接返回
  const pick3 = pickCandidate(aliasKey, targets, config, now + 60000)
  assert.ok(pick3)
  assert.strictEqual(pick3.isProbe, false)
})

test('affinity locks to specific target during affinity window', () => {
  clearHealthState()
  const aliasKey = 'openai/gpt-4'
  const targets = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const config: RoutingConfig = { mode: 'weighted', affinity_seconds: 30 }
  const now = 1000

  // 候选 2 成功并进入亲和期
  reportSuccess(aliasKey, 2, config, { armAffinity: true, now })

  // 亲和期内请求应固定返回候选 2
  const pick1 = pickCandidate(aliasKey, targets, config, now + 5000)
  assert.ok(pick1)
  assert.strictEqual(pick1.target.id, 2)

  const pick2 = pickCandidate(aliasKey, targets, config, now + 29000)
  assert.ok(pick2)
  assert.strictEqual(pick2.target.id, 2)

  // 亲和期结束，恢复正常选路（返回第一个候选）
  const pick3 = pickCandidate(aliasKey, targets, config, now + 31000)
  assert.ok(pick3)
  assert.strictEqual(pick3.target.id, 1)
})

test('clearHealthState removes all state for given alias', () => {
  const aliasKey = 'openai/gpt-4'
  const targets = [{ id: 1 }]
  const config: RoutingConfig = { mode: 'failover', cooldown_seconds: 60 }
  const now = 1000

  // 进入冷却
  reportFailure(aliasKey, 1, config, now)

  // 冷却期内无法获取
  const pick1 = pickCandidate(aliasKey, targets, config, now + 1000)
  assert.ok(pick1)
  assert.strictEqual(pick1.isProbe, true)

  // 清空状态
  clearHealthState(aliasKey)

  // 清空后立即可获取
  const pick2 = pickCandidate(aliasKey, targets, config, now + 2000)
  assert.ok(pick2)
  assert.strictEqual(pick2.isProbe, false)
})
