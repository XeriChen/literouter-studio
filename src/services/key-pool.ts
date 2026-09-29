import { parseAuth, type ParsedAuth } from '../providers/headers'
import type { ProviderRow } from '../types'

export interface PoolKey { id: string; key: string; name: string }
export interface KeyPick { credential: PoolKey; isProbe: boolean }

const MAX_COOLDOWN_MS = 3_600_000
const PROBE_TTL_MS = 120_000
const cursor = new Map<string, number>()
const cooldowns = new Map<string, number>()
const probes = new Map<string, number>()

function scope(providerId: string, keyId: string, model: string | null): string {
  return JSON.stringify([providerId, keyId, model])
}

function keyScopes(providerId: string, keyId: string, model: string): string[] {
  return [scope(providerId, keyId, null), scope(providerId, keyId, model)]
}

function poolKeys(auth: ParsedAuth): PoolKey[] {
  if (auth.api_keys) return auth.api_keys.filter((item) => item.enabled && item.key).map(({ id, key, name }) => ({ id, key, name }))
  return auth.api_key ? [{ id: 'legacy', key: auth.api_key, name: 'Default' }] : []
}

export function providerKeys(provider: ProviderRow): PoolKey[] {
  return poolKeys(parseAuth(provider))
}

export function hasKeyPool(provider: ProviderRow): boolean {
  return parseAuth(provider).api_keys !== undefined
}

/** All selection state is changed synchronously before any upstream await. */
export function pickKey(provider: ProviderRow, model: string, excluded: Set<string>, now = Date.now()): KeyPick | null {
  const auth = parseAuth(provider)
  const keys = poolKeys(auth)
  if (!keys.length) return null
  const strategy = auth.key_strategy ?? 'polling'
  const ordered = [...keys]
  if (strategy === 'random') {
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!]
    }
  }
  const start = strategy === 'polling' ? (cursor.get(provider.id) ?? 0) % ordered.length : 0
  for (let offset = 0; offset < ordered.length; offset++) {
    const credential = ordered[(start + offset) % ordered.length]!
    if (excluded.has(credential.id)) continue
    const scopes = keyScopes(provider.id, credential.id, model)
    if (scopes.some((s) => (probes.get(s) ?? 0) > now)) continue
    const until = Math.max(...scopes.map((s) => cooldowns.get(s) ?? 0))
    if (until === 0) {
      if (strategy === 'polling') cursor.set(provider.id, (start + offset + 1) % ordered.length)
      return { credential, isProbe: false }
    }
    if (until <= now) {
      const activeScope = scopes.find((s) => cooldowns.has(s))!
      probes.set(activeScope, now + PROBE_TTL_MS)
      if (strategy === 'polling') cursor.set(provider.id, (start + offset + 1) % ordered.length)
      return { credential, isProbe: true }
    }
  }
  return null
}

export function retryAfterMs(headers: Record<string, string | string[] | undefined>, now = Date.now()): number | null {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]))
  const retry = lower['retry-after']
  if (retry) {
    const seconds = Number(retry)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now
    if (Number.isFinite(ms)) return Math.max(0, Math.min(MAX_COOLDOWN_MS, ms))
  }
  for (const name of ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset']) {
    const value = lower[name]
    if (!value) continue
    const numeric = Number(value)
    const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)]
    const duration = parts.length && parts.map((part) => part[0]).join('') === value
      ? parts.reduce((total, part) => total + Number(part[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[part[2] as 'ms' | 's' | 'm' | 'h']), 0)
      : NaN
    const ms = Number.isFinite(numeric) ? (numeric > 1e12 ? numeric - now : numeric > 1e9 ? numeric * 1000 - now : numeric * 1000)
      : Number.isFinite(duration) ? duration : Date.parse(value) - now
    if (Number.isFinite(ms)) return Math.max(0, Math.min(MAX_COOLDOWN_MS, ms))
  }
  return null
}

export function reportKeyFailure(providerId: string, keyId: string, model: string, status: number | null, defaultSeconds: number, headers: Record<string, string | string[] | undefined> = {}, now = Date.now()): void {
  const global = status === 401 || status === 402 || status === 403
  const target = scope(providerId, keyId, global ? null : model)
  for (const s of keyScopes(providerId, keyId, model)) probes.delete(s)
  // defaultSeconds 显式为 0 = 该候选的 Key 永不冷却，上游 Retry-After 也不得突破
  const ms = defaultSeconds === 0 ? 0 : (retryAfterMs(headers, now) ?? Math.min(MAX_COOLDOWN_MS, defaultSeconds * 1000))
  if (ms > 0) cooldowns.set(target, now + ms)
}

export function reportKeySuccess(providerId: string, keyId: string, model: string): void {
  for (const s of keyScopes(providerId, keyId, model)) {
    cooldowns.delete(s)
    probes.delete(s)
  }
}

export function releaseKeyProbe(providerId: string, keyId: string, model: string): void {
  for (const s of keyScopes(providerId, keyId, model)) probes.delete(s)
}

export function clearKeyPoolState(providerId?: string): void {
  if (!providerId) { cursor.clear(); cooldowns.clear(); probes.clear(); return }
  cursor.delete(providerId)
  const prefix = `${JSON.stringify([providerId]).slice(0, -1)},`
  for (const map of [cooldowns, probes]) for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key)
  }
}

export function keyPoolStatus(provider: ProviderRow, now = Date.now()): Array<{ id: string; cooldown_until: number | null }> {
  const auth = parseAuth(provider)
  return (auth.api_keys ?? []).map((item) => {
    const prefix = `${JSON.stringify([provider.id, item.id]).slice(0, -1)},`
    let until = 0
    for (const [key, value] of cooldowns) if (key.startsWith(prefix)) until = Math.max(until, value)
    return { id: item.id, cooldown_until: until > now ? until : null }
  })
}

export function nextKeyRetrySeconds(provider: ProviderRow, model: string, now = Date.now()): number | null {
  const keys = providerKeys(provider)
  if (!keys.length) return null
  let earliest = Infinity
  for (const item of keys) {
    const scopes = keyScopes(provider.id, item.id, model)
    const until = Math.max(...scopes.map((s) => cooldowns.get(s) ?? 0))
    if (until === 0) return null
    if (until <= now && scopes.every((s) => (probes.get(s) ?? 0) <= now)) return null
    earliest = Math.min(earliest, Math.max(until, ...scopes.map((s) => probes.get(s) ?? 0)))
  }
  return Number.isFinite(earliest) ? Math.max(1, Math.ceil((earliest - now) / 1000)) : null
}
