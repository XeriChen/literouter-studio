import type { MiddlewareHandler } from 'hono'
import { writeLog } from '../services/logs'
import type { Env } from '../types'

export const logMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const startedAt = Date.now()
  const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null
  await next()
  if (!c.req.path.startsWith('/api')) return
  writeLog({
    client_ip: clientIp,
    protocol: null,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latency_ms: Date.now() - startedAt,
  })
}