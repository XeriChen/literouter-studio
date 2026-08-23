import type { Hono } from 'hono'
import { z } from 'zod'
import { exportBackup, importBackup } from '../../services/backup'
import { writeAuditLog } from '../../services/audit'
import { getAdminToken } from '../../services/auth'
import type { Env } from '../../types'
import { fail, nonEmptyText, ok, providerSchema, readJson, settingsSchema, thinkingConfigSchema } from './shared'

const backupSchema = z.object({
  token: nonEmptyText,
  settings: settingsSchema.default({}),
  providers: z.array(providerSchema.extend({ id: nonEmptyText, enabled: z.union([z.literal(0), z.literal(1)]).default(1) })).default([]),
  provider_groups: z.array(
    z.object({
      protocol: z.enum(['openai', 'anthropic']),
      id: nonEmptyText,
      name: nonEmptyText,
    }),
  ).default([]),
  models: z.array(
    z.object({
      provider_id: nonEmptyText,
      model_id: nonEmptyText,
      display_name: z.string().trim().nullable().optional(),
      enabled: z.union([z.literal(0), z.literal(1)]).default(0),
      source: z.enum(['fetched', 'manual']).default('manual'),
    }),
  ).default([]),
  groups: z.array(
    z.object({
      protocol: z.enum(['openai', 'anthropic']),
      id: nonEmptyText,
      name: nonEmptyText,
    }),
  ).default([]),
  aliases: z.array(z.object({
    protocol: z.enum(['openai', 'anthropic']),
    alias_name: nonEmptyText,
    group_id: nonEmptyText.nullable().default(null),
    enabled: z.union([z.literal(0), z.literal(1)]).default(1),
    thinking: thinkingConfigSchema.nullable().default(null),
    targets: z.array(z.object({
      provider_id: nonEmptyText,
      model_id: nonEmptyText,
      priority: z.number().int().min(0).default(0),
      active: z.union([z.literal(0), z.literal(1)]).default(0),
    })),
  })).default([]),
})

export function registerBackupRoutes(api: Hono<Env>): void {
  api.get('/backup', (c) => {
    const backup = exportBackup()
    writeAuditLog({
      resource: 'backup',
      action: 'export',
        detail: `导出备份: ${backup.providers.length} 个 Provider, ${backup.models.length} 个模型, ${backup.aliases.length} 个映射, ${backup.provider_groups.length + backup.groups.length} 个分组`,
      status: 200,
    })
    return ok(c, backup)
  })

  api.post('/backup', async (c) => {
    const parsed = backupSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid backup data', 'invalid_request_body')

    const data = parsed.data
    try {
      const now = new Date().toISOString()
      importBackup({
        token: data.token,
        settings: data.settings,
        providers: data.providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          protocol: provider.protocol,
          group_id: provider.group_id ?? null,
          base_url: provider.base_url,
          auth: provider.auth,
          custom_headers: provider.custom_headers,
          proxy_url: provider.proxy_url ?? null,
          timeout_ms: provider.timeout_ms ?? null,
          model_filter: provider.model_filter ?? null,
          enabled: provider.enabled,
          created_at: now,
          updated_at: now,
        })),
        models: data.models.map((model) => ({ ...model, display_name: model.display_name ?? null })),
        provider_groups: data.provider_groups,
        groups: data.groups,
        aliases: data.aliases,
      })
      writeAuditLog({
        resource: 'backup',
        action: 'import',
        detail: `导入备份: ${data.providers.length} 个 Provider, ${data.models.length} 个模型, ${data.aliases.length} 个映射, ${data.provider_groups.length + data.groups.length} 个分组`,
        status: 200,
      })
      return ok(c, { token: getAdminToken() })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'import failed'
      writeAuditLog({ resource: 'backup', action: 'import', detail: `导入备份失败: ${message}`, status: 400 })
      return fail(c, 400, message, 'invalid_backup')
    }
  })
}
