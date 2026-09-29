import { Hono } from 'hono'
import { z } from 'zod'
import { parseAuth } from '../../providers/headers'
import { getProvider } from '../../services/providers'
import { getUpstreamCapabilities } from '../../services/upstream-capabilities'
import {
  createNewApiToken,
  deleteNewApiToken,
  importNewApiTokensToPool,
  listNewApiTokens,
  revealNewApiTokenKey,
  updateNewApiToken,
} from '../../services/newapi-tokens'
import { writeAuditLog } from '../../services/audit'
import type { AuditAction } from '../../services/audit'
import { UpstreamError, httpStatusForUpstreamError } from '../../services/errors'
import { redactText } from '../../services/redact'
import type { Env, ProviderRow } from '../../types'
import { fail, ok, readJson } from './shared'

const app = new Hono<Env>()

const createSchema = z.object({
  name: z.string().trim().min(1).max(50),
  unlimited: z.boolean().default(false),
  quota_usd: z.number().min(0).optional(),
  expired_time: z.number().int().optional(),
  group: z.string().optional(),
})

const updateSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  status: z.union([z.literal(1), z.literal(2)]).optional(),
  unlimited: z.boolean().optional(),
  quota_usd: z.number().min(0).optional(),
  expired_time: z.number().int().optional(),
  // 本网关不编辑、仅透传保留：new-api 整对象覆盖会清空缺省字段，编辑时需回填
  group: z.string().optional(),
  model_limits_enabled: z.boolean().optional(),
  model_limits: z.string().optional(),
  allow_ips: z.string().optional(),
  cross_group_retry: z.boolean().optional(),
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), 'token patch cannot be empty')

const importSchema = z.object({
  tokens: z.array(z.object({ id: z.number().int(), name: z.string() })).min(1).max(100),
})

interface ResolvedProvider {
  provider: ProviderRow
  accessToken: string
}

/** 解析 Provider 并校验其支持令牌管理且已配置控制台 access_token。 */
function resolveProvider(id: string): ResolvedProvider | { error: { status: number; message: string; code: string } } {
  const provider = getProvider(id)
  if (!provider) return { error: { status: 404, message: 'provider not found', code: 'provider_not_found' } }
  if (!getUpstreamCapabilities(provider.upstream_type).tokenManagement.supported) {
    return { error: { status: 400, message: 'provider upstream_type does not support token management', code: 'invalid_upstream_type' } }
  }
  const accessToken = parseAuth(provider).access_token
  if (!accessToken) {
    return { error: { status: 400, message: 'provider has no access_token; configure the console token first', code: 'access_token_missing' } }
  }
  return { provider, accessToken }
}

/** 统一把 UpstreamError 映射为管理 API 的 HTTP 状态 + 脱敏消息，并落审计。 */
function respondError(c: Parameters<typeof fail>[0], err: unknown, provider: ProviderRow, action: AuditAction) {
  const code = err instanceof UpstreamError ? err.code : 'upstream_error'
  const rawMessage = err instanceof Error ? err.message : 'unknown error'
  const status = httpStatusForUpstreamError(code)
  writeAuditLog({ resource: 'token', target: provider.name, action, detail: redactText(`${code}: ${rawMessage}`), status })
  return fail(c, status, redactText(rawMessage), code)
}

app.get('/:id/newapi/tokens', async (c) => {
  const resolved = resolveProvider(c.req.param('id'))
  if ('error' in resolved) return fail(c, resolved.error.status, resolved.error.message, resolved.error.code)
  const page = Math.max(1, Number(c.req.query('p')) || 1)
  const size = Math.min(100, Math.max(1, Number(c.req.query('size')) || 20))
  try {
    return ok(c, await listNewApiTokens(resolved.provider, resolved.accessToken, { page, size }))
  } catch (err) {
    return respondError(c, err, resolved.provider, 'fetch')
  }
})

app.post('/:id/newapi/tokens/:tokenId/reveal', async (c) => {
  const resolved = resolveProvider(c.req.param('id'))
  if ('error' in resolved) return fail(c, resolved.error.status, resolved.error.message, resolved.error.code)
  const tokenId = Number(c.req.param('tokenId'))
  if (!Number.isInteger(tokenId)) return fail(c, 400, 'invalid token id', 'invalid_request_body')
  try {
    const key = await revealNewApiTokenKey(resolved.provider, resolved.accessToken, tokenId)
    writeAuditLog({ resource: 'token', target: resolved.provider.name, action: 'reveal', detail: `查看令牌 #${tokenId} 明文 key`, status: 200 })
    return ok(c, { key })
  } catch (err) {
    return respondError(c, err, resolved.provider, 'reveal')
  }
})

app.post('/:id/newapi/tokens', async (c) => {
  const resolved = resolveProvider(c.req.param('id'))
  if ('error' in resolved) return fail(c, resolved.error.status, resolved.error.message, resolved.error.code)
  const parsed = createSchema.safeParse(await readJson(c))
  if (!parsed.success) return fail(c, 400, 'invalid token config', 'invalid_request_body')
  try {
    await createNewApiToken(resolved.provider, resolved.accessToken, parsed.data)
    writeAuditLog({ resource: 'token', target: resolved.provider.name, action: 'create', detail: `新建上游令牌 ${parsed.data.name}`, status: 200 })
    return ok(c, {})
  } catch (err) {
    return respondError(c, err, resolved.provider, 'create')
  }
})

app.put('/:id/newapi/tokens/:tokenId', async (c) => {
  const resolved = resolveProvider(c.req.param('id'))
  if ('error' in resolved) return fail(c, resolved.error.status, resolved.error.message, resolved.error.code)
  const tokenId = Number(c.req.param('tokenId'))
  if (!Number.isInteger(tokenId)) return fail(c, 400, 'invalid token id', 'invalid_request_body')
  const parsed = updateSchema.safeParse(await readJson(c))
  if (!parsed.success) return fail(c, 400, 'invalid token config', 'invalid_request_body')
  try {
    const { statusOnly } = await updateNewApiToken(resolved.provider, resolved.accessToken, { id: tokenId, ...parsed.data })
    const detail = statusOnly
      ? `${parsed.data.status === 1 ? '启用' : '禁用'}上游令牌 #${tokenId}`
      : `更新上游令牌 #${tokenId}`
    writeAuditLog({ resource: 'token', target: resolved.provider.name, action: 'update', detail, status: 200 })
    return ok(c, {})
  } catch (err) {
    return respondError(c, err, resolved.provider, 'update')
  }
})

app.delete('/:id/newapi/tokens/:tokenId', async (c) => {
  const resolved = resolveProvider(c.req.param('id'))
  if ('error' in resolved) return fail(c, resolved.error.status, resolved.error.message, resolved.error.code)
  const tokenId = Number(c.req.param('tokenId'))
  if (!Number.isInteger(tokenId)) return fail(c, 400, 'invalid token id', 'invalid_request_body')
  try {
    await deleteNewApiToken(resolved.provider, resolved.accessToken, tokenId)
    writeAuditLog({ resource: 'token', target: resolved.provider.name, action: 'delete', detail: `删除上游令牌 #${tokenId}`, status: 200 })
    return ok(c, {})
  } catch (err) {
    return respondError(c, err, resolved.provider, 'delete')
  }
})

app.post('/:id/newapi/tokens/import', async (c) => {
  const resolved = resolveProvider(c.req.param('id'))
  if ('error' in resolved) return fail(c, resolved.error.status, resolved.error.message, resolved.error.code)
  const parsed = importSchema.safeParse(await readJson(c))
  if (!parsed.success) return fail(c, 400, 'tokens must be a non-empty array', 'invalid_request_body')
  try {
    const result = await importNewApiTokensToPool(resolved.provider, resolved.accessToken, parsed.data.tokens)
    const cappedNote = result.capped > 0 ? `, 超上限跳过 ${result.capped}` : ''
    writeAuditLog({ resource: 'token', target: resolved.provider.name, action: 'import', detail: `导入上游令牌到本地 Key 池: 新增 ${result.added}, 跳过 ${result.skipped}${cappedNote}`, status: 200 })
    return ok(c, result)
  } catch (err) {
    return respondError(c, err, resolved.provider, 'import')
  }
})

export default app
