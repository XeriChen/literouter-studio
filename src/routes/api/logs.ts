import type { Hono } from 'hono'
import { clearAuditLogs, listAuditLogs, writeAuditLog } from '../../services/audit'
import { clearLogs, listLogs } from '../../services/logs'
import type { Env } from '../../types'
import { ok } from './shared'

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function registerLogRoutes(api: Hono<Env>): void {
  api.get('/logs', (c) => {
    const query = c.req.query()
    const status = query.status === undefined ? undefined : finiteNumber(query.status, Number.NaN)
    return ok(
      c,
      listLogs({
        page: finiteNumber(query.page, 1),
        pageSize: finiteNumber(query.page_size, 50),
        protocol: query.protocol || undefined,
        provider_id: query.provider_id || undefined,
        model: query.model || undefined,
        status: Number.isFinite(status) ? status : undefined,
      }),
    )
  })

  api.delete('/logs', (c) => {
    clearLogs()
    writeAuditLog({ resource: 'logs', action: 'clear', detail: '清空代理访问日志', status: 200 })
    return ok(c, {})
  })

  api.get('/audit-logs', (c) => {
    const query = c.req.query()
    return ok(
      c,
      listAuditLogs({
        page: finiteNumber(query.page, 1),
        pageSize: finiteNumber(query.page_size, 50),
        resource: query.resource || undefined,
      }),
    )
  })

  api.delete('/audit-logs', (c) => {
    clearAuditLogs()
    return ok(c, {})
  })
}
