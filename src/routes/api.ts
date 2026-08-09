import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { authMiddleware } from '../middlewares/auth'
import { logMiddleware } from '../middlewares/log'
import { verifyToken, resetAdminToken, getAdminToken } from '../services/auth'
import { createProvider, deleteProvider, listUpstreamModels, importModels, getProvider, listProviders, testProviderConnection, updateProvider } from '../services/providers'
import { addAlias, addModel, deleteAlias, deleteModel, getAlias, getModel, listAliases, listModels, setModelEnabled, updateAlias } from '../services/models'
import { clearLogs, listLogs } from '../services/logs'
import { getSettings, updateSettings } from '../services/settings'
import { exportBackup, importBackup } from '../services/backup'
import { testModelLiveness, validateTestPrompt } from '../services/liveness'
import { parseAuth, parseCustomHeaders } from '../providers/headers'
import type { ApiResponse, Env, ProviderProtocol, ProviderRow } from '../types'

type ApiC = Context<Env>

export const api = new Hono<Env>()

function ok(c: ApiC, data: unknown) {
  return c.json({ ok: true, data } as ApiResponse<unknown>)
}

function fail(c: ApiC, status: number, message: string, code: string) {
  return c.json(
    { ok: false, error: { message, type: code, code } } as ApiResponse<never>,
    status as ContentfulStatusCode,
  )
}

const authSchema = z.record(z.string(), z.string())

// ---------- Auth ----------

api.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  const token = (body as { token?: string } | null)?.token
  if (!token || !verifyToken(token)) {
    return fail(c, 401, 'invalid token', 'invalid_api_key')
  }
  return ok(c, { token })
})

api.use('*', logMiddleware)
api.use('*', authMiddleware)

api.get('/me', (c) => ok(c, { token: getAdminToken() }))

api.post('/token/reset', (c) => ok(c, { token: resetAdminToken() }))

// ---------- Settings ----------

api.get('/settings', (c) => ok(c, getSettings()))

const settingsSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.string().regex(/^\d{1,5}$/).refine((v) => Number(v) >= 1 && Number(v) <= 65535, 'port 无效').optional(),
  global_timeout_ms: z.string().regex(/^\d+$/).optional(),
})

api.put('/settings', async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid settings', 'invalid_request_body')
  return ok(c, updateSettings(parsed.data))
})

// ---------- Providers ----------

const providerSchema = z.object({
  name: z.string().min(1),
  protocol: z.enum(['openai', 'anthropic']),
  base_url: z.string().min(1),
  auth: authSchema.default({}),
  custom_headers: authSchema.default({}),
  proxy_url: z.string().nullable().optional(),
  timeout_ms: z.number().int().min(0).nullable().optional(),
  model_filter: z.string().nullable().optional(),
})

function providerOut(p: ProviderRow) {
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    base_url: p.base_url,
    auth: parseAuth(p),
    custom_headers: parseCustomHeaders(p),
    proxy_url: p.proxy_url,
    timeout_ms: p.timeout_ms,
    model_filter: p.model_filter,
    enabled: p.enabled,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }
}

api.get('/providers', (c) => ok(c, listProviders().map(providerOut)))

api.post('/providers', async (c) => {
  const parsed = providerSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid provider config', 'invalid_request_body')
  const p = parsed.data
  const row = createProvider({
    name: p.name,
    protocol: p.protocol as ProviderProtocol,
    base_url: p.base_url,
    auth_json: JSON.stringify(p.auth),
    custom_headers_json: JSON.stringify(p.custom_headers),
    proxy_url: p.proxy_url ?? null,
    timeout_ms: p.timeout_ms ?? null,
    model_filter: p.model_filter ?? null,
  })
  return ok(c, providerOut(row))
})

api.get('/providers/:id', (c) => {
  const p = getProvider(c.req.param('id'))
  if (!p) return fail(c, 404, 'provider not found', 'provider_not_found')
  return ok(c, providerOut(p))
})

const providerPatchSchema = providerSchema.partial()

api.put('/providers/:id', async (c) => {
  const parsed = providerPatchSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid provider config', 'invalid_request_body')
  const p = parsed.data
  if (!getProvider(c.req.param('id'))) return fail(c, 404, 'provider not found', 'provider_not_found')
  const row = updateProvider(c.req.param('id'), {
    name: p.name,
    base_url: p.base_url,
    auth_json: p.auth ? JSON.stringify(p.auth) : undefined,
    custom_headers_json: p.custom_headers ? JSON.stringify(p.custom_headers) : undefined,
    proxy_url: p.proxy_url === undefined ? undefined : p.proxy_url,
    timeout_ms: p.timeout_ms === undefined ? undefined : p.timeout_ms,
    model_filter: p.model_filter === undefined ? undefined : p.model_filter,
  })
  return ok(c, providerOut(row))
})

api.delete('/providers/:id', (c) => {
  if (!getProvider(c.req.param('id'))) return fail(c, 404, 'provider not found', 'provider_not_found')
  deleteProvider(c.req.param('id'))
  return ok(c, {})
})

api.post('/providers/:id/test', async (c) => {
  const p = getProvider(c.req.param('id'))
  if (!p) return fail(c, 404, 'provider not found', 'provider_not_found')
  const result = await testProviderConnection(p.id)
  return ok(c, result)
})

api.post('/providers/:id/upstream-models', async (c) => {
  const p = getProvider(c.req.param('id'))
  if (!p) return fail(c, 404, 'provider not found', 'provider_not_found')
  try {
    const modelIds = await listUpstreamModels(p.id)
    return ok(c, { model_ids: modelIds })
  } catch (err) {
    return fail(c, 502, err instanceof Error ? err.message : 'fetch models failed', 'upstream_error')
  }
})

api.post('/providers/:id/import-models', async (c) => {
  const p = getProvider(c.req.param('id'))
  if (!p) return fail(c, 404, 'provider not found', 'provider_not_found')
  const body = await c.req.json().catch(() => null) as { model_ids?: unknown } | null
  if (!Array.isArray(body?.model_ids) || body.model_ids.length === 0) {
    return fail(c, 400, 'model_ids must be a non-empty array', 'invalid_request_body')
  }
  const ids = body.model_ids.filter((x: unknown): x is string => typeof x === 'string')
  if (!ids.length) return fail(c, 400, 'no valid model ids', 'invalid_request_body')
  const result = importModels(p.id, ids)
  return ok(c, result)
})

// ---------- Models (Body 传参，支持含 / 的 model_id) ----------

const modelRefSchema = z.object({
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
})

api.get('/models', (c) => ok(c, listModels()))

api.post('/models', async (c) => {
  const parsed = modelRefSchema
    .extend({ display_name: z.string().nullable().optional() })
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')
  if (!getProvider(parsed.data.provider_id)) return fail(c, 404, 'provider not found', 'provider_not_found')
  const row = addModel({ ...parsed.data, display_name: parsed.data.display_name ?? null })
  return ok(c, row)
})

api.patch('/models', async (c) => {
  const parsed = modelRefSchema
    .extend({ enabled: z.union([z.literal(0), z.literal(1)]) })
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')
  if (!getProvider(parsed.data.provider_id)) return fail(c, 404, 'provider not found', 'provider_not_found')
  if (!getModel(parsed.data.provider_id, parsed.data.model_id)) {
    return fail(c, 404, 'model not found', 'model_not_found')
  }
  const row = setModelEnabled(parsed.data)
  return ok(c, row)
})

api.delete('/models', async (c) => {
  const parsed = modelRefSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')
  deleteModel(parsed.data)
  return ok(c, {})
})

// ---------- Aliases（模型映射：客户端可见模型名 -> 真实模型） ----------

const aliasRefSchema = z.object({
  protocol: z.enum(['openai', 'anthropic']),
  alias_name: z.string().min(1),
})

const aliasSchema = aliasRefSchema.extend({
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  new_alias_name: z.string().min(1).optional(),
})

/** 校验映射目标：Provider 存在且协议一致、模型存在且已启用；通过返回 null */
function aliasTargetError(c: ApiC, body: { protocol: ProviderProtocol; provider_id: string; model_id: string }): Response | null {
  const provider = getProvider(body.provider_id)
  if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
  if (provider.protocol !== body.protocol) {
    return fail(c, 400, 'provider protocol mismatch', 'invalid_request_body')
  }
  const model = getModel(body.provider_id, body.model_id)
  if (!model) return fail(c, 404, 'model not found', 'model_not_found')
  if (!model.enabled) return fail(c, 400, 'target model must be enabled first', 'invalid_request_body')
  return null
}

api.get('/aliases', (c) => ok(c, listAliases()))

api.post('/aliases', async (c) => {
  const parsed = aliasSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
  if (getAlias(parsed.data.protocol, parsed.data.alias_name)) {
    return fail(c, 400, 'alias name already exists', 'alias_exists')
  }
  const err = aliasTargetError(c, parsed.data)
  if (err) return err
  const row = addAlias(parsed.data)
  return ok(c, row)
})

api.patch('/aliases', async (c) => {
  const parsed = aliasSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
  if (!getAlias(parsed.data.protocol, parsed.data.alias_name)) {
    return fail(c, 404, 'alias not found', 'alias_not_found')
  }
  if (parsed.data.new_alias_name && parsed.data.new_alias_name !== parsed.data.alias_name) {
    if (getAlias(parsed.data.protocol, parsed.data.new_alias_name)) {
      return fail(c, 400, 'alias name already exists', 'alias_exists')
    }
  }
  const err = aliasTargetError(c, parsed.data)
  if (err) return err
  const row = updateAlias(parsed.data)
  return ok(c, row)
})

api.delete('/aliases', async (c) => {
  const parsed = aliasRefSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
  deleteAlias(parsed.data)
  return ok(c, {})
})

const DEFAULT_TEST_PROMPT = '现在的美国总统是谁'

api.post('/models/test', async (c) => {
  const parsed = modelRefSchema
    .extend({ prompt: z.string().optional() })
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')
  const provider = getProvider(parsed.data.provider_id)
  if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
  if (!provider.enabled) return fail(c, 503, 'provider disabled', 'provider_disabled')

  const prompt = parsed.data.prompt?.trim() || DEFAULT_TEST_PROMPT
  const invalidReason = validateTestPrompt(prompt)
  if (invalidReason) return fail(c, 400, invalidReason, 'invalid_test_prompt')

  try {
    const result = await testModelLiveness({ provider_id: parsed.data.provider_id, model_id: parsed.data.model_id, prompt })
    return ok(c, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'liveness test failed'
    if (message === 'upstream_timeout') return fail(c, 504, '模型测活超时', 'upstream_timeout')
    return fail(c, 502, message, 'upstream_error')
  }
})

// ---------- Logs ----------

api.get('/logs', (c) => {
  const q = c.req.query()
  const page = Number(q.page ?? 1)
  const pageSize = Number(q.page_size ?? 50)
  const status = q.status ? Number(q.status) : undefined
  return ok(
    c,
    listLogs({
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 50,
      protocol: q.protocol || undefined,
      provider_id: q.provider_id || undefined,
      model: q.model || undefined,
      status: status !== undefined && Number.isFinite(status) ? status : undefined,
    }),
  )
})

api.delete('/logs', (c) => {
  clearLogs()
  return ok(c, {})
})

// ---------- Backup ----------

api.get('/backup', (c) => ok(c, exportBackup()))

const backupSchema = z.object({
  token: z.string().min(1),
  settings: z.record(z.string(), z.string()).default({}),
  providers: z.array(providerSchema.extend({ id: z.string().min(1), enabled: z.number().int().default(1) })).default([]),
  models: z.array(
    z.object({
      provider_id: z.string().min(1),
      model_id: z.string().min(1),
      display_name: z.string().nullable().optional(),
      enabled: z.number().int().default(0),
      source: z.enum(['fetched', 'manual']).default('manual'),
    }),
  ).default([]),
  aliases: z.array(
    z.object({
      protocol: z.enum(['openai', 'anthropic']),
      alias_name: z.string().min(1),
      provider_id: z.string().min(1),
      model_id: z.string().min(1),
    }),
  ).default([]),
})

api.post('/backup', async (c) => {
  const parsed = backupSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(c, 400, 'invalid backup data', 'invalid_request_body')
  const data = parsed.data
  try {
    importBackup({
      token: data.token,
      settings: data.settings,
      providers: data.providers.map((p) => ({
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        base_url: p.base_url,
        auth: p.auth,
        custom_headers: p.custom_headers,
        proxy_url: p.proxy_url ?? null,
        timeout_ms: p.timeout_ms ?? null,
        model_filter: p.model_filter ?? null,
        enabled: p.enabled,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })),
      models: data.models.map((m) => ({ ...m, display_name: m.display_name ?? null })),
      aliases: data.aliases.map((a) => ({ ...a })),
    })
    // 导入后 token 已被备份内容覆盖，重新读取返回
    return ok(c, { token: getAdminToken() })
  } catch (err) {
    return fail(c, 400, err instanceof Error ? err.message : 'import failed', 'invalid_backup')
  }
})