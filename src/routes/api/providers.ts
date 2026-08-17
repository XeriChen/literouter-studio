import type { Hono } from 'hono'
import { isTimeoutError } from '../../proxy'
import { writeAuditLog } from '../../services/audit'
import {
  createProvider,
  deleteProvider,
  getProvider,
  importModels,
  listProviders,
  listUpstreamModels,
  testProviderConnection,
  updateProvider,
} from '../../services/providers'
import type { Env, ProviderProtocol } from '../../types'
import { fail, ok, providerOut, providerPatchSchema, providerSchema, readJson } from './shared'

export function registerProviderRoutes(api: Hono<Env>): void {
  api.get('/providers', (c) => ok(c, listProviders().map(providerOut)))

  api.post('/providers', async (c) => {
    const parsed = providerSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid provider config', 'invalid_request_body')

    const provider = parsed.data
    const row = createProvider({
      name: provider.name,
      protocol: provider.protocol as ProviderProtocol,
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

    const row = updateProvider(c.req.param('id'), {
      name: patch.name,
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
