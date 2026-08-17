import type { Hono } from 'hono'
import { z } from 'zod'
import { isTimeoutError } from '../../proxy'
import { writeAuditLog } from '../../services/audit'
import {
  createProvider,
  createProviderGroup,
  deleteGroupProviders,
  deleteProvider,
  deleteProviderGroup,
  enableGroupProviders,
  getProvider,
  getProviderGroup,
  importModels,
  listProviderGroups,
  listProviders,
  listUpstreamModels,
  testProviderConnection,
  updateProvider,
  updateProviderGroup,
} from '../../services/providers'
import type { Env, ProviderProtocol } from '../../types'
import { fail, nonEmptyText, ok, providerGroupRefSchema, providerOut, providerPatchSchema, providerSchema, readJson } from './shared'

export function registerProviderRoutes(api: Hono<Env>): void {
  api.get('/providers', (c) => ok(c, listProviders().map(providerOut)))

  api.post('/providers', async (c) => {
    const parsed = providerSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid provider config', 'invalid_request_body')

    const provider = parsed.data
    if (provider.group_id && !getProviderGroup(provider.protocol, provider.group_id)) {
      return fail(c, 404, 'provider group not found', 'provider_group_not_found')
    }
    const row = createProvider({
      name: provider.name,
      protocol: provider.protocol as ProviderProtocol,
      group_id: provider.group_id ?? null,
      base_url: provider.base_url,
      auth_json: JSON.stringify(provider.auth),
      custom_headers_json: JSON.stringify(provider.custom_headers),
      proxy_url: provider.proxy_url ?? null,
      timeout_ms: provider.timeout_ms ?? null,
      model_filter: provider.model_filter ?? null,
    })
    writeAuditLog({ resource: 'provider', action: 'create', target: row.name, detail: `新建 Provider: ${row.name}`, status: 200 })
    return ok(c, providerOut(row))
  })

  api.get('/providers/:id', (c) => {
    const provider = getProvider(c.req.param('id'))
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
    return ok(c, providerOut(provider))
  })

  api.put('/providers/:id', async (c) => {
    const parsed = providerPatchSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid provider config', 'invalid_request_body')

    const patch = parsed.data
    const existing = getProvider(c.req.param('id'))
    if (!existing) return fail(c, 404, 'provider not found', 'provider_not_found')
    if (patch.group_id && !getProviderGroup(existing.protocol, patch.group_id)) {
      return fail(c, 404, 'provider group not found', 'provider_group_not_found')
    }

    const row = updateProvider(c.req.param('id'), {
      name: patch.name,
      group_id: patch.group_id,
      base_url: patch.base_url,
      auth_json: patch.auth ? JSON.stringify(patch.auth) : undefined,
      custom_headers_json: patch.custom_headers ? JSON.stringify(patch.custom_headers) : undefined,
      proxy_url: patch.proxy_url,
      timeout_ms: patch.timeout_ms,
      model_filter: patch.model_filter,
      enabled: patch.enabled,
    })
    const changed = Object.entries(patch).filter(([, value]) => value !== undefined)
    const onlyEnabledChanged = changed.length === 1 && patch.enabled !== undefined && patch.enabled !== existing.enabled
    writeAuditLog({
      resource: 'provider',
      action: 'update',
      target: row.name,
      detail: onlyEnabledChanged
        ? `${patch.enabled ? '启用' : '禁用'} Provider ${row.name}`
        : `更新 Provider ${existing.name}: ${changed.map(([key]) => key).join(', ')}`,
      status: 200,
    })
    return ok(c, providerOut(row))
  })

  api.delete('/providers/:id', (c) => {
    const provider = getProvider(c.req.param('id'))
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')
    deleteProvider(provider.id)
    writeAuditLog({ resource: 'provider', action: 'delete', target: provider.name, detail: `删除 Provider ${provider.name}`, status: 200 })
    return ok(c, {})
  })

  api.get('/provider-groups', (c) => ok(c, listProviderGroups()))

  api.post('/provider-groups', async (c) => {
    const parsed = z.object({ protocol: z.enum(['openai', 'anthropic']), name: nonEmptyText }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid provider group', 'invalid_request_body')
    try {
      const row = createProviderGroup(parsed.data)
      writeAuditLog({ resource: 'provider_group', action: 'create', target: row.name, detail: `新建 Provider 分组 ${row.name} (${row.protocol})`, status: 200 })
      return ok(c, row)
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'provider group exists', 'provider_group_exists')
    }
  })

  api.patch('/provider-groups', async (c) => {
    const parsed = providerGroupRefSchema.extend({ name: nonEmptyText }).safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid provider group', 'invalid_request_body')
    const group = getProviderGroup(parsed.data.protocol, parsed.data.group_id)
    if (!group) return fail(c, 404, 'provider group not found', 'provider_group_not_found')
    try {
      const row = updateProviderGroup({ protocol: parsed.data.protocol, id: parsed.data.group_id, name: parsed.data.name })
      writeAuditLog({ resource: 'provider_group', action: 'update', target: row.name, detail: `重命名 Provider 分组 ${group.name} 为 ${row.name}`, status: 200 })
      return ok(c, row)
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : 'provider group exists', 'provider_group_exists')
    }
  })

  api.delete('/provider-groups', async (c) => {
    const parsed = providerGroupRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid provider group', 'invalid_request_body')
    const group = getProviderGroup(parsed.data.protocol, parsed.data.group_id)
    if (!group) return fail(c, 404, 'provider group not found', 'provider_group_not_found')
    const ungrouped = deleteProviderGroup({ protocol: parsed.data.protocol, id: parsed.data.group_id })
    writeAuditLog({ resource: 'provider_group', action: 'delete', target: group.name, detail: `删除 Provider 分组 ${group.name}，${ungrouped} 个 Provider 移至未分组`, status: 200 })
    return ok(c, { ungrouped })
  })

  api.post('/provider-groups/batch-enable', async (c) => {
    const parsed = providerGroupRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid provider group', 'invalid_request_body')
    const group = getProviderGroup(parsed.data.protocol, parsed.data.group_id)
    if (!group) return fail(c, 404, 'provider group not found', 'provider_group_not_found')
    const updated = enableGroupProviders(parsed.data)
    writeAuditLog({ resource: 'provider', action: 'batch_enable', target: group.name, detail: `批量启用 Provider 分组 ${group.name} 内 ${updated} 个 Provider`, status: 200 })
    return ok(c, { updated })
  })

  api.post('/provider-groups/batch-delete', async (c) => {
    const parsed = providerGroupRefSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid provider group', 'invalid_request_body')
    const group = getProviderGroup(parsed.data.protocol, parsed.data.group_id)
    if (!group) return fail(c, 404, 'provider group not found', 'provider_group_not_found')
    const deleted = deleteGroupProviders(parsed.data)
    writeAuditLog({ resource: 'provider', action: 'batch_delete', target: group.name, detail: `批量删除 Provider 分组 ${group.name} 内 ${deleted} 个 Provider`, status: 200 })
    return ok(c, { deleted })
  })

  api.post('/providers/:id/test', async (c) => {
    const provider = getProvider(c.req.param('id'))
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')

    const result = await testProviderConnection(provider.id)
    writeAuditLog({
      resource: 'provider',
      action: 'test',
      target: provider.name,
      detail: `测活 Provider ${provider.name}${result.ok ? `: 网络可达 (HTTP ${result.status})` : `: ${result.message}`}`,
      status: result.ok ? 200 : 502,
    })
    return ok(c, result)
  })

  api.post('/providers/:id/upstream-models', async (c) => {
    const provider = getProvider(c.req.param('id'))
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')

    try {
      const modelIds = await listUpstreamModels(provider.id)
      writeAuditLog({ resource: 'model', action: 'fetch', target: provider.name, detail: `拉取上游模型 ${provider.name}: ${modelIds.length} 个`, status: 200 })
      return ok(c, { model_ids: modelIds })
    } catch (error) {
      const timeout = isTimeoutError(error)
      const status = timeout ? 504 : 502
      const message = timeout ? 'upstream timeout' : error instanceof Error ? error.message : 'fetch models failed'
      writeAuditLog({ resource: 'model', action: 'fetch', target: provider.name, detail: `拉取上游模型 ${provider.name} 失败: ${message}`, status })
      return fail(c, status, message, timeout ? 'upstream_timeout' : 'upstream_error')
    }
  })

  api.post('/providers/:id/import-models', async (c) => {
    const provider = getProvider(c.req.param('id'))
    if (!provider) return fail(c, 404, 'provider not found', 'provider_not_found')

    const body = await readJson(c) as { model_ids?: unknown } | null
    if (!Array.isArray(body?.model_ids) || body.model_ids.length === 0) {
      return fail(c, 400, 'model_ids must be a non-empty array', 'invalid_request_body')
    }
    const ids = [...new Set(body.model_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
    if (!ids.length) return fail(c, 400, 'no valid model ids', 'invalid_request_body')

    const result = importModels(provider.id, ids)
    writeAuditLog({ resource: 'model', action: 'import', target: provider.name, detail: `导入模型到 ${provider.name}: 新增 ${result.added}, 更新 ${result.updated}`, status: 200 })
    return ok(c, result)
  })
}
