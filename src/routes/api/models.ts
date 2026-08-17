import type { Hono } from 'hono'
import { z } from 'zod'
import { writeAuditLog } from '../../services/audit'
import {
  addAlias,
  addModel,
  deleteAlias,
  deleteModel,
  getAlias,
  getModel,
  listAliases,
  listModels,
  setModelEnabled,
  updateAlias,
} from '../../services/models'
import { getProvider } from '../../services/providers'
import { testModelLiveness, validateTestPrompt } from '../../services/liveness'
import type { Env, ProviderProtocol } from '../../types'
import { aliasRefSchema, aliasSchema, type ApiContext, fail, modelRefSchema, ok, readJson } from './shared'

const DEFAULT_TEST_PROMPT = '现在的美国总统是谁'
const zeroOrOne = z.union([z.literal(0), z.literal(1)])
const displayName = z.string().trim().nullable().optional()

function aliasTargetError(
  c: ApiContext,
  body: { protocol: ProviderProtocol; provider_id: string; model_id: string },
): Response | null {
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

export function registerModelRoutes(api: Hono<Env>): void {
  api.get('/models', (c) => ok(c, listModels()))

  api.post('/models', async (c) => {
    const parsed = modelRefSchema.extend({ display_name: displayName }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')

    const provider = getProvider(parsed.data.provider_id)
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')

    const row = addModel({ ...parsed.data, display_name: parsed.data.display_name ?? null })
    writeAuditLog({ resource: 'model', action: 'create', target: row.model_id, detail: `新增模型 ${row.model_id} (${provider.name})`, status: 200 })
    return ok(c, row)
  })

  api.patch('/models', async (c) => {
    const parsed = modelRefSchema.extend({ enabled: zeroOrOne }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')

    const provider = getProvider(parsed.data.provider_id)
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
    if (!getModel(parsed.data.provider_id, parsed.data.model_id)) {
      return fail(c, 404, 'model not found', 'model_not_found')
    }

    const row = setModelEnabled(parsed.data)
    writeAuditLog({
      resource: 'model',
      action: 'update',
      target: row.model_id,
      detail: `${parsed.data.enabled ? '启用' : '禁用'}模型 ${row.model_id} (${provider.name})`,
      status: 200,
    })
    return ok(c, row)
  })

  api.delete('/models', async (c) => {
    const parsed = modelRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')

    const provider = getProvider(parsed.data.provider_id)
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
    if (!getModel(parsed.data.provider_id, parsed.data.model_id)) {
      return fail(c, 404, 'model not found', 'model_not_found')
    }

    deleteModel(parsed.data)
    writeAuditLog({ resource: 'model', action: 'delete', target: parsed.data.model_id, detail: `删除模型 ${parsed.data.model_id} (${provider.name})`, status: 200 })
    return ok(c, {})
  })

  api.get('/aliases', (c) => ok(c, listAliases()))

  api.post('/aliases', async (c) => {
    const parsed = aliasSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
    if (getAlias(parsed.data.protocol, parsed.data.alias_name)) {
      return fail(c, 400, 'alias name already exists', 'alias_exists')
    }

    const error = aliasTargetError(c, parsed.data)
    if (error) return error
    const row = addAlias(parsed.data)
    writeAuditLog({ resource: 'alias', action: 'create', target: row.alias_name, detail: `新建映射 ${row.alias_name} → ${row.provider_id}/${row.model_id}`, status: 200 })
    return ok(c, row)
  })

  api.patch('/aliases', async (c) => {
    const parsed = aliasSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
    if (!getAlias(parsed.data.protocol, parsed.data.alias_name)) {
      return fail(c, 404, 'alias not found', 'alias_not_found')
    }
    if (parsed.data.new_alias_name && parsed.data.new_alias_name !== parsed.data.alias_name) {
      if (getAlias(parsed.data.protocol, parsed.data.new_alias_name)) {
        return fail(c, 400, 'alias name already exists', 'alias_exists')
      }
    }

    const error = aliasTargetError(c, parsed.data)
    if (error) return error
    const row = updateAlias(parsed.data)
    const details = [`指向 ${row.provider_id}/${row.model_id}`]
    if (parsed.data.new_alias_name && parsed.data.new_alias_name !== parsed.data.alias_name) {
      details.unshift(`映射名 ${parsed.data.alias_name} → ${parsed.data.new_alias_name}`)
    }
    writeAuditLog({ resource: 'alias', action: 'update', target: row.alias_name, detail: `更新映射 ${row.alias_name}: ${details.join(', ')}`, status: 200 })
    return ok(c, row)
  })

  api.delete('/aliases', async (c) => {
    const parsed = aliasRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
    if (!getAlias(parsed.data.protocol, parsed.data.alias_name)) {
      return fail(c, 404, 'alias not found', 'alias_not_found')
    }

    deleteAlias(parsed.data)
    writeAuditLog({ resource: 'alias', action: 'delete', target: parsed.data.alias_name, detail: `删除映射 ${parsed.data.alias_name}`, status: 200 })
    return ok(c, {})
  })

  api.post('/models/test', async (c) => {
    const parsed = modelRefSchema.extend({ prompt: z.string().optional() }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')

    const provider = getProvider(parsed.data.provider_id)
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
    const model = getModel(parsed.data.provider_id, parsed.data.model_id)
    if (!model || !model.enabled) return fail(c, 404, 'model not found', 'model_not_found')
    if (!provider.enabled) return fail(c, 503, 'provider disabled', 'provider_disabled')

    const prompt = parsed.data.prompt?.trim() || DEFAULT_TEST_PROMPT
    const invalidReason = validateTestPrompt(prompt)
    if (invalidReason) return fail(c, 400, invalidReason, 'invalid_test_prompt')

    try {
      const result = await testModelLiveness({ provider_id: parsed.data.provider_id, model_id: parsed.data.model_id, prompt })
      writeAuditLog({ resource: 'model', action: 'test', target: parsed.data.model_id, detail: `测活模型 ${parsed.data.model_id} (${provider.name}): ${result.latency_ms}ms`, status: 200 })
      return ok(c, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'liveness test failed'
      const status = message === 'upstream_timeout' ? 504 : 502
      writeAuditLog({ resource: 'model', action: 'test', target: parsed.data.model_id, detail: `测活模型 ${parsed.data.model_id} (${provider.name}) 失败: ${message}`, status })
      return fail(c, status, status === 504 ? '模型测活超时' : message, status === 504 ? 'upstream_timeout' : 'upstream_error')
    }
  })
}
