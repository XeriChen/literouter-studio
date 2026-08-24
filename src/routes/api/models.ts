import type { Hono } from 'hono'
import { z } from 'zod'
import { writeAuditLog } from '../../services/audit'
import {
  activateAliasTarget,
  addAlias,
  addAliasTarget,
  addModel,
  createAliasGroup,
  deleteAlias,
  deleteAliasGroup,
  deleteAliasTarget,
  deleteGroupAliases,
  deleteModel,
  enableGroupAliases,
  getAlias,
  getAliasGroup,
  getAliasTarget,
  getModel,
  listAliases,
  listAliasGroups,
  listModels,
  reorderAliasTargets,
  setModelEnabled,
  updateAlias,
  updateAliasGroup,
  validateThinkingValue,
} from '../../services/models'
import { getProvider } from '../../services/providers'
import { testModelLiveness, validateTestPrompt } from '../../services/liveness'
import type { Env, ProviderProtocol } from '../../types'
import {
  aliasGroupRefSchema,
  aliasPatchSchema,
  aliasRefSchema,
  aliasSchema,
  aliasTargetRefSchema,
  fail,
  modelRefSchema,
  nonEmptyText,
  type ApiContext,
  ok,
  readJson,
  thinkingConfigSchema,
} from './shared'

const DEFAULT_TEST_PROMPT = '现在的美国总统是谁'
const zeroOrOne = z.union([z.literal(0), z.literal(1)])
const displayName = z.string().trim().nullable().optional()

function aliasTargetError(
  c: ApiContext,
  body: { protocol: ProviderProtocol; provider_id: string; model_id: string },
): Response | null {
  const provider = getProvider(body.provider_id)
  if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
  if (provider.protocol !== body.protocol) return fail(c, 400, 'provider protocol mismatch', 'invalid_request_body')
  const model = getModel(body.provider_id, body.model_id)
  if (!model) return fail(c, 404, 'model not found', 'model_not_found')
  if (!provider.enabled || !model.enabled) return fail(c, 400, 'target provider and model must be enabled first', 'invalid_request_body')
  return null
}

function groupError(c: ApiContext, protocol: ProviderProtocol, groupId: string | null | undefined): Response | null {
  if (groupId === undefined || groupId === null) return null
  const group = getAliasGroup(protocol, groupId)
  if (!group) return fail(c, 404, 'alias group not found', 'alias_group_not_found')
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
    if (!getModel(parsed.data.provider_id, parsed.data.model_id)) return fail(c, 404, 'model not found', 'model_not_found')
    const row = setModelEnabled(parsed.data)
    writeAuditLog({ resource: 'model', action: 'update', target: row.model_id, detail: `${parsed.data.enabled ? '启用' : '禁用'}模型 ${row.model_id} (${provider.name})`, status: 200 })
    return ok(c, row)
  })

  api.delete('/models', async (c) => {
    const parsed = modelRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')
    const provider = getProvider(parsed.data.provider_id)
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
    if (!getModel(parsed.data.provider_id, parsed.data.model_id)) return fail(c, 404, 'model not found', 'model_not_found')
    deleteModel(parsed.data)
    writeAuditLog({ resource: 'model', action: 'delete', target: parsed.data.model_id, detail: `删除模型 ${parsed.data.model_id} (${provider.name})`, status: 200 })
    return ok(c, {})
  })

  api.get('/aliases', (c) => ok(c, listAliases()))

  api.post('/aliases', async (c) => {
    const parsed = aliasSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
    if (getAlias(parsed.data.protocol, parsed.data.alias_name)) return fail(c, 400, 'alias name already exists', 'alias_exists')
    const groupProblem = groupError(c, parsed.data.protocol, parsed.data.group_id)
    if (groupProblem) return groupProblem
    const targetProblem = aliasTargetError(c, parsed.data)
    if (targetProblem) return targetProblem
    const row = addAlias(parsed.data)
    const thinkingNote = parsed.data.thinking ? `，思考等级${parsed.data.thinking.mode === 'override' ? '强制覆盖' : '仅默认'}` : ''
    writeAuditLog({ resource: 'alias', action: 'create', target: row.alias_name, detail: `新建映射 ${row.alias_name} → ${parsed.data.provider_id}/${parsed.data.model_id}${thinkingNote}`, status: 200 })
    return ok(c, row)
  })

  api.patch('/aliases', async (c) => {
    const parsed = aliasPatchSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
    const existing = getAlias(parsed.data.protocol, parsed.data.alias_name)
    if (!existing) return fail(c, 404, 'alias not found', 'alias_not_found')
    if (parsed.data.new_alias_name && parsed.data.new_alias_name !== parsed.data.alias_name && getAlias(parsed.data.protocol, parsed.data.new_alias_name)) {
      return fail(c, 400, 'alias name already exists', 'alias_exists')
    }
    const groupProblem = groupError(c, parsed.data.protocol, parsed.data.group_id)
    if (groupProblem) return groupProblem
    if (parsed.data.provider_id !== undefined && parsed.data.model_id !== undefined) {
      const targetProblem = aliasTargetError(c, parsed.data as { protocol: ProviderProtocol; provider_id: string; model_id: string })
      if (targetProblem) return targetProblem
    }
    try {
      const row = updateAlias(parsed.data)
      const details: string[] = []
      if (parsed.data.new_alias_name) details.push(`映射名改为 ${parsed.data.new_alias_name}`)
      if (parsed.data.group_id !== undefined) details.push(parsed.data.group_id ? `分组 ${parsed.data.group_id}` : '移出分组')
      if (parsed.data.enabled !== undefined) details.push(parsed.data.enabled ? '启用' : '禁用')
      if (parsed.data.provider_id) details.push(`当前目标 ${parsed.data.provider_id}/${parsed.data.model_id}`)
      if (parsed.data.thinking !== undefined) details.push(parsed.data.thinking ? `思考等级 ${parsed.data.thinking.mode === 'override' ? '强制覆盖' : '仅默认'}` : '清除思考等级')
      writeAuditLog({ resource: 'alias', action: 'update', target: row.alias_name, detail: `更新映射 ${row.alias_name}: ${details.join(', ')}`, status: 200 })
      return ok(c, row)
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'invalid alias', 'invalid_request_body')
    }
  })

  api.delete('/aliases', async (c) => {
    const parsed = aliasRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias', 'invalid_request_body')
    if (!getAlias(parsed.data.protocol, parsed.data.alias_name)) return fail(c, 404, 'alias not found', 'alias_not_found')
    deleteAlias(parsed.data)
    writeAuditLog({ resource: 'alias', action: 'delete', target: parsed.data.alias_name, detail: `删除映射 ${parsed.data.alias_name}`, status: 200 })
    return ok(c, {})
  })

  api.get('/alias-groups', (c) => ok(c, listAliasGroups()))

  api.post('/alias-groups', async (c) => {
    const parsed = z.object({ protocol: z.enum(['openai', 'anthropic']), name: nonEmptyText }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias group', 'invalid_request_body')
    try {
      const row = createAliasGroup(parsed.data)
      writeAuditLog({ resource: 'alias_group', action: 'create', target: row.name, detail: `新建映射分组 ${row.name}`, status: 200 })
      return ok(c, row)
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'alias group exists', 'alias_group_exists')
    }
  })

  api.patch('/alias-groups', async (c) => {
    const parsed = aliasGroupRefSchema.extend({ name: nonEmptyText }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias group', 'invalid_request_body')
    if (!getAliasGroup(parsed.data.protocol, parsed.data.group_id)) return fail(c, 404, 'alias group not found', 'alias_group_not_found')
    try {
      const row = updateAliasGroup({ protocol: parsed.data.protocol, id: parsed.data.group_id, name: parsed.data.name })
      writeAuditLog({ resource: 'alias_group', action: 'update', target: row.name, detail: `重命名映射分组 ${row.name}`, status: 200 })
      return ok(c, row)
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'alias group exists', 'alias_group_exists')
    }
  })

  api.delete('/alias-groups', async (c) => {
    const parsed = aliasGroupRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias group', 'invalid_request_body')
    const group = getAliasGroup(parsed.data.protocol, parsed.data.group_id)
    if (!group) return fail(c, 404, 'alias group not found', 'alias_group_not_found')
    const deletedAliases = deleteAliasGroup({ protocol: parsed.data.protocol, id: parsed.data.group_id })
    writeAuditLog({ resource: 'alias_group', action: 'delete', target: group.name, detail: `删除映射分组 ${group.name} 及 ${deletedAliases} 个映射`, status: 200 })
    return ok(c, { deleted_aliases: deletedAliases })
  })

  api.post('/alias-groups/batch-enable', async (c) => {
    const parsed = aliasGroupRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias group', 'invalid_request_body')
    if (!getAliasGroup(parsed.data.protocol, parsed.data.group_id)) return fail(c, 404, 'alias group not found', 'alias_group_not_found')
    const count = enableGroupAliases(parsed.data)
    writeAuditLog({ resource: 'alias', action: 'batch_enable', target: parsed.data.group_id, detail: `批量启用分组内 ${count} 个映射`, status: 200 })
    return ok(c, { updated: count })
  })

  api.post('/alias-groups/batch-delete', async (c) => {
    const parsed = aliasGroupRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias group', 'invalid_request_body')
    if (!getAliasGroup(parsed.data.protocol, parsed.data.group_id)) return fail(c, 404, 'alias group not found', 'alias_group_not_found')
    const count = deleteGroupAliases(parsed.data)
    writeAuditLog({ resource: 'alias', action: 'batch_delete', target: parsed.data.group_id, detail: `批量删除分组内 ${count} 个映射`, status: 200 })
    return ok(c, { deleted: count })
  })

  api.post('/alias-targets', async (c) => {
    const parsed = aliasTargetRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias target', 'invalid_request_body')
    if (!getAlias(parsed.data.protocol, parsed.data.alias_name)) return fail(c, 404, 'alias not found', 'alias_not_found')
    const targetProblem = aliasTargetError(c, parsed.data)
    if (targetProblem) return targetProblem
    if (getAliasTarget(parsed.data)) return fail(c, 400, 'alias target already exists', 'alias_target_exists')
    try {
      const row = addAliasTarget(parsed.data)
      writeAuditLog({ resource: 'alias_target', action: 'create', target: parsed.data.alias_name, detail: `添加候选 ${parsed.data.provider_id}/${parsed.data.model_id}`, status: 200 })
      return ok(c, row)
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'invalid alias target', 'invalid_request_body')
    }
  })

  api.patch('/alias-targets', async (c) => {
    const parsed = aliasTargetRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias target', 'invalid_request_body')
    if (!getAlias(parsed.data.protocol, parsed.data.alias_name)) return fail(c, 404, 'alias not found', 'alias_not_found')
    if (!getAliasTarget(parsed.data)) return fail(c, 404, 'alias target not found', 'alias_target_not_found')
    const targetProblem = aliasTargetError(c, parsed.data)
    if (targetProblem) return targetProblem
    try {
      const row = activateAliasTarget(parsed.data)
      writeAuditLog({ resource: 'alias_target', action: 'activate', target: parsed.data.alias_name, detail: `切换当前目标至 ${parsed.data.provider_id}/${parsed.data.model_id}`, status: 200 })
      return ok(c, row)
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'invalid alias target', 'invalid_request_body')
    }
  })

  api.delete('/alias-targets', async (c) => {
    const parsed = aliasTargetRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias target', 'invalid_request_body')
    if (!getAlias(parsed.data.protocol, parsed.data.alias_name)) return fail(c, 404, 'alias not found', 'alias_not_found')
    if (!getAliasTarget(parsed.data)) return fail(c, 404, 'alias target not found', 'alias_target_not_found')
    try {
      deleteAliasTarget(parsed.data)
      writeAuditLog({ resource: 'alias_target', action: 'delete', target: parsed.data.alias_name, detail: `删除候选 ${parsed.data.provider_id}/${parsed.data.model_id}`, status: 200 })
      return ok(c, {})
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'invalid alias target', 'invalid_request_body')
    }
  })

  api.post('/alias-targets/reorder', async (c) => {
    const parsed = aliasRefSchema.extend({
      targets: z.array(z.object({ provider_id: nonEmptyText, model_id: nonEmptyText })).min(1),
    }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid alias target order', 'invalid_request_body')
    if (!getAlias(parsed.data.protocol, parsed.data.alias_name)) return fail(c, 404, 'alias not found', 'alias_not_found')
    try {
      reorderAliasTargets(parsed.data)
      writeAuditLog({ resource: 'alias_target', action: 'reorder', target: parsed.data.alias_name, detail: `重排映射候选优先级`, status: 200 })
      return ok(c, {})
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'invalid alias target order', 'invalid_request_body')
    }
  })

  api.post('/models/test', async (c) => {
    const parsed = modelRefSchema.extend({ prompt: z.string().optional(), thinking: thinkingConfigSchema.nullable().optional() }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid model', 'invalid_request_body')
    const provider = getProvider(parsed.data.provider_id)
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
    const model = getModel(parsed.data.provider_id, parsed.data.model_id)
    if (!model) return fail(c, 404, 'model not found', 'model_not_found')
    if (!provider.enabled) return fail(c, 503, 'provider disabled', 'provider_disabled')
    if (parsed.data.thinking && !validateThinkingValue(provider.protocol, parsed.data.thinking.value)) {
      return fail(c, 400, 'invalid thinking config', 'invalid_request_body')
    }
    const prompt = parsed.data.prompt?.trim() || DEFAULT_TEST_PROMPT
    const invalidReason = validateTestPrompt(prompt)
    if (invalidReason) return fail(c, 400, invalidReason, 'invalid_test_prompt')
    const thinkingNote = parsed.data.thinking ? '（含思考等级）' : ''
    try {
      const result = await testModelLiveness({ provider_id: parsed.data.provider_id, model_id: parsed.data.model_id, prompt, thinking: parsed.data.thinking ?? null })
      writeAuditLog({ resource: 'model', action: 'test', target: parsed.data.model_id, detail: `测活模型 ${parsed.data.model_id} (${provider.name})${thinkingNote}: ${result.latency_ms}ms`, status: 200 })
      return ok(c, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'liveness test failed'
      const status = message === 'upstream_timeout' ? 504 : 502
      writeAuditLog({ resource: 'model', action: 'test', target: parsed.data.model_id, detail: `测活模型 ${parsed.data.model_id} (${provider.name}) 失败: ${message}`, status })
      return fail(c, status, status === 504 ? '模型测活超时' : message, status === 504 ? 'upstream_timeout' : 'upstream_error')
    }
  })
}
