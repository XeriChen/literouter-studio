import { randomUUID } from 'node:crypto'
import { request } from 'undici'
import { getDispatcher } from '../proxy'
import { parseAuth } from '../providers/headers'
import type { ProviderRow } from '../types'
import { UpstreamError } from './errors'
import { assertSafeOutboundUrl } from './url-guard'
import { billingRoot, roundMoney, statusToErrorCode, toFiniteNumber } from './balance/shared'
import { updateProvider } from './providers'

/**
 * new-api 控制台令牌（Token）管理：走 `/api/token` 全套（UserAuth 中间件），
 * 认证用 Provider 的 access_token（控制台 PAT，`Authorization: Bearer`），
 * 与余额查询 `/api/user/self` 同一凭据。sk- 代理密钥打这些端点会被 401。
 * 额度换算沿用 new-api 默认 QuotaPerUnit：$1 = 500000 quota。
 */
const NEWAPI_QUOTA_PER_USD = 500_000
export const NEWAPI_TOKEN_STATUS_ENABLED = 1
export const NEWAPI_TOKEN_STATUS_DISABLED = 2

/**
 * 归一化后的令牌视图（额度已折算美元；列表接口返回的 key 为掩码）。
 * group / model_limits* / allow_ips / cross_group_retry 为「本网关不编辑、仅透传保留」的字段：
 * new-api 的 UpdateToken 非 status_only 分支会整对象覆盖，编辑时必须回填以免清空/重置。
 */
export interface NewApiToken {
  id: number
  name: string
  key: string
  status: number
  unlimited: boolean
  remain_usd: number | null
  used_usd: number
  expired_time: number
  group: string
  model_limits_enabled: boolean
  model_limits: string
  allow_ips: string
  cross_group_retry: boolean
}

export interface NewApiTokenPage {
  items: NewApiToken[]
  total: number
  page: number
  page_size: number
}

export interface CreateTokenInput {
  name: string
  unlimited: boolean
  quota_usd?: number
  expired_time?: number
  group?: string
}

export interface UpdateTokenInput {
  id: number
  name?: string
  status?: number
  unlimited?: boolean
  quota_usd?: number
  expired_time?: number
  group?: string
  model_limits_enabled?: boolean
  model_limits?: string
  allow_ips?: string
  cross_group_retry?: boolean
}

export interface ImportTokenRef {
  id: number
  name: string
}

interface RequestContext {
  dispatcher: ReturnType<typeof getDispatcher>
  signal: AbortSignal
  done: () => void
}

/** 每次上游调用独立超时：沿用 Provider 自身 proxy_url / timeout_ms。 */
function providerContext(provider: ProviderRow): RequestContext {
  const timeout = provider.timeout_ms || 30_000
  const dispatcher = getDispatcher(provider.proxy_url, timeout)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)
  return { dispatcher, signal: controller.signal, done: () => clearTimeout(timeoutId) }
}

/**
 * 发起控制台请求并解析 `{success, message, data}` 信封。
 * 非 200（含中间件 401/403）与 200 包 success=false 都抛 UpstreamError；
 * 返回 data 供各操作按形状取用。
 */
async function consoleRequest(
  provider: ProviderRow,
  accessToken: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  dispatcher: ReturnType<typeof getDispatcher>,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  const url = `${billingRoot(provider.base_url)}${path}`
  assertSafeOutboundUrl(url)

  const headers: Record<string, string> = { 'accept': 'application/json', 'authorization': `Bearer ${accessToken}` }
  let payload: string | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const response = await request(url, { method, headers, dispatcher, signal, body: payload })
  const status = response.statusCode

  let json: unknown
  try {
    json = await response.body.json()
  } catch {
    if (status !== 200) throw new UpstreamError(statusToErrorCode(status), `newapi console returned HTTP ${status}`, status)
    throw new UpstreamError('upstream_error', 'newapi console response is not valid JSON', 200)
  }

  const envelope = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {}
  const message = typeof envelope.message === 'string' && envelope.message.trim() ? envelope.message.trim() : null

  if (status !== 200) {
    throw new UpstreamError(statusToErrorCode(status), message ?? `newapi console returned HTTP ${status}`, status)
  }
  if (envelope.success === false) {
    throw new UpstreamError('upstream_error', message ?? 'newapi console returned success=false', 200)
  }
  return envelope.data
}

/** new-api 令牌对象 → 归一化视图（额度折算美元，无限额时 remain_usd 为 null）。 */
function mapToken(raw: unknown): NewApiToken {
  const t = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const unlimited = t.unlimited_quota === true
  const remainRaw = toFiniteNumber(t.remain_quota)
  const usedRaw = toFiniteNumber(t.used_quota) ?? 0
  return {
    id: toFiniteNumber(t.id) ?? 0,
    name: typeof t.name === 'string' ? t.name : '',
    key: typeof t.key === 'string' ? t.key : '',
    status: toFiniteNumber(t.status) ?? 0,
    unlimited,
    remain_usd: unlimited || remainRaw === null ? null : roundMoney(remainRaw / NEWAPI_QUOTA_PER_USD),
    used_usd: roundMoney(usedRaw / NEWAPI_QUOTA_PER_USD),
    expired_time: toFiniteNumber(t.expired_time) ?? -1,
    group: typeof t.group === 'string' ? t.group : '',
    model_limits_enabled: t.model_limits_enabled === true,
    model_limits: typeof t.model_limits === 'string' ? t.model_limits : '',
    allow_ips: typeof t.allow_ips === 'string' ? t.allow_ips : '',
    cross_group_retry: t.cross_group_retry === true,
  }
}

/** 列出令牌（分页）。响应 data 形如 `{page, page_size, total, items:[Token]}`。 */
export async function listNewApiTokens(
  provider: ProviderRow,
  accessToken: string,
  options: { page: number; size: number },
): Promise<NewApiTokenPage> {
  const ctx = providerContext(provider)
  try {
    const data = await consoleRequest(
      provider, accessToken, 'GET',
      `/api/token/?p=${options.page}&page_size=${options.size}`,
      ctx.dispatcher, ctx.signal,
    )
    const page = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    const items = Array.isArray(page.items) ? page.items.map(mapToken) : []
    return {
      items,
      total: toFiniteNumber(page.total) ?? items.length,
      page: toFiniteNumber(page.page) ?? options.page,
      page_size: toFiniteNumber(page.page_size) ?? options.size,
    }
  } finally {
    ctx.done()
  }
}

/** 取令牌全量 key（列表只给掩码，需单独 `POST /api/token/:id/key`）。 */
export async function revealNewApiTokenKey(provider: ProviderRow, accessToken: string, tokenId: number): Promise<string> {
  const ctx = providerContext(provider)
  try {
    const data = await consoleRequest(provider, accessToken, 'POST', `/api/token/${tokenId}/key`, ctx.dispatcher, ctx.signal)
    const key = data && typeof data === 'object' ? (data as Record<string, unknown>).key : undefined
    if (typeof key !== 'string' || !key) throw new UpstreamError('upstream_error', 'newapi did not return the token key', 200)
    return key
  } finally {
    ctx.done()
  }
}

/** 折算美元额度为 new-api 内部额度单位（整数 quota）。 */
function quotaFromUsd(usd: number | undefined): number {
  return Math.max(0, Math.round((usd ?? 0) * NEWAPI_QUOTA_PER_USD))
}

/** 新建令牌。 */
export async function createNewApiToken(provider: ProviderRow, accessToken: string, input: CreateTokenInput): Promise<void> {
  const ctx = providerContext(provider)
  try {
    await consoleRequest(provider, accessToken, 'POST', '/api/token/', ctx.dispatcher, ctx.signal, {
      name: input.name,
      unlimited_quota: input.unlimited,
      remain_quota: input.unlimited ? 0 : quotaFromUsd(input.quota_usd),
      expired_time: input.expired_time ?? -1,
      group: input.group ?? '',
    })
  } finally {
    ctx.done()
  }
}

/**
 * 更新令牌。仅传 status（不含其它字段）时走 `?status_only=1` 只改启停，
 * 避免误清名称/额度/到期/分组/白名单；否则整对象覆盖（new-api UpdateToken 语义）。
 * 返回是否走了 status_only 分支，供路由据实写审计文案（单一事实来源）。
 */
export async function updateNewApiToken(
  provider: ProviderRow,
  accessToken: string,
  input: UpdateTokenInput,
): Promise<{ statusOnly: boolean }> {
  const statusOnly = input.status !== undefined
    && input.name === undefined && input.quota_usd === undefined
    && input.unlimited === undefined && input.expired_time === undefined
    && input.group === undefined && input.model_limits_enabled === undefined
    && input.model_limits === undefined && input.allow_ips === undefined
    && input.cross_group_retry === undefined
  const ctx = providerContext(provider)
  try {
    if (statusOnly) {
      await consoleRequest(provider, accessToken, 'PUT', '/api/token/?status_only=1', ctx.dispatcher, ctx.signal, {
        id: input.id,
        status: input.status,
      })
      return { statusOnly: true }
    }
    const unlimited = input.unlimited ?? false
    const body: Record<string, unknown> = {
      id: input.id,
      name: input.name ?? '',
      unlimited_quota: unlimited,
      remain_quota: unlimited ? 0 : quotaFromUsd(input.quota_usd),
      expired_time: input.expired_time ?? -1,
      group: input.group ?? '',
      model_limits_enabled: input.model_limits_enabled ?? false,
      model_limits: input.model_limits ?? '',
      allow_ips: input.allow_ips ?? '',
      cross_group_retry: input.cross_group_retry ?? false,
    }
    if (input.status !== undefined) body.status = input.status
    await consoleRequest(provider, accessToken, 'PUT', '/api/token/', ctx.dispatcher, ctx.signal, body)
    return { statusOnly: false }
  } finally {
    ctx.done()
  }
}

/** 删除令牌。 */
export async function deleteNewApiToken(provider: ProviderRow, accessToken: string, tokenId: number): Promise<void> {
  const ctx = providerContext(provider)
  try {
    await consoleRequest(provider, accessToken, 'DELETE', `/api/token/${tokenId}`, ctx.dispatcher, ctx.signal)
  } finally {
    ctx.done()
  }
}

/** 本地 Key 池上限，与 authSchema `api_keys.max(100)` 对齐；超限则该 Provider 无法再从 UI 保存。 */
const MAX_KEY_POOL = 100

/**
 * 把选中的上游令牌导入 Provider 本地 Key 池（逐 Key 故障转移）：
 * 逐个取全量 key（尊重 /key 的限流），按 key 值去重后追加为启用条目；
 * 原有单 api_key 迁移为池内 Default 条目。池达 100 上限即停止导入，
 * 剩余记入 capped（避免写出超限、导致 Provider 在 UI 里保存失败）。有新增才落库。
 */
export async function importNewApiTokensToPool(
  provider: ProviderRow,
  accessToken: string,
  tokens: ImportTokenRef[],
): Promise<{ added: number; skipped: number; capped: number; pool_size: number }> {
  const auth = parseAuth(provider)
  const pool = auth.api_keys
    ? [...auth.api_keys]
    : auth.api_key
      ? [{ id: randomUUID(), name: 'Default', key: auth.api_key, enabled: true }]
      : []
  const seen = new Set(pool.map((item) => item.key))

  let added = 0
  let skipped = 0
  let capped = 0
  for (const token of tokens) {
    if (pool.length >= MAX_KEY_POOL) {
      capped++
      continue
    }
    const key = await revealNewApiTokenKey(provider, accessToken, token.id)
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    pool.push({ id: randomUUID(), name: token.name.trim() || `newapi-${token.id}`, key, enabled: true })
    added++
  }

  if (added > 0) {
    const nextAuth: Record<string, unknown> = { api_keys: pool, key_strategy: auth.key_strategy ?? 'polling' }
    if (auth.access_token) nextAuth.access_token = auth.access_token
    if (auth.version) nextAuth.version = auth.version
    if (auth.custom_auth) nextAuth.custom_auth = auth.custom_auth
    updateProvider(provider.id, { auth_json: JSON.stringify(nextAuth) })
  }

  return { added, skipped, capped, pool_size: pool.length }
}
