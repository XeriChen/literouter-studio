import type { Hono } from 'hono'
import { writeAuditLog } from '../../services/audit'
import { getSettings, updateSettings } from '../../services/settings'
import type { Env } from '../../types'
import { fail, ok, readJson, settingsSchema } from './shared'

export function registerSettingsRoutes(api: Hono<Env>): void {
  api.get('/settings', (c) => ok(c, getSettings()))

  api.put('/settings', async (c) => {
    const parsed = settingsSchema.safeParse(await readJson(c))
    if (!parsed.success) return fail(c, 400, 'invalid settings', 'invalid_request_body')

    const before = getSettings()
    const after = updateSettings(parsed.data)
    const changed = Object.keys(parsed.data).filter((key) => before[key] !== after[key])
    if (changed.length) {
      writeAuditLog({
        resource: 'settings',
        action: 'update',
        detail: `更新设置: ${changed.map((key) => `${key}: ${before[key]} → ${after[key]}`).join('; ')}`,
        status: 200,
      })
    }
    return ok(c, after)
  })
}
