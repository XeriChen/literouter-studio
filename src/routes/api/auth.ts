import type { Hono } from 'hono'
import { getAdminToken, resetAdminToken, verifyToken } from '../../services/auth'
import { writeAuditLog } from '../../services/audit'
import type { Env } from '../../types'
import { fail, ok, readJson } from './shared'

export function registerPublicAuthRoutes(api: Hono<Env>): void {
  api.post('/login', async (c) => {
    const body = await readJson(c) as { token?: unknown } | null
    const token = typeof body?.token === 'string' ? body.token : null
    if (!token || !verifyToken(token)) {
      writeAuditLog({ resource: 'auth', action: 'login_failed', detail: '令牌验证失败', status: 401 })
      return fail(c, 401, 'invalid token', 'invalid_api_key')
    }
    writeAuditLog({ resource: 'auth', action: 'login', detail: '登录成功', status: 200 })
    return ok(c, { token })
  })
}

export function registerProtectedAuthRoutes(api: Hono<Env>): void {
  api.get('/me', (c) => ok(c, { token: getAdminToken() }))

  api.post('/token/reset', (c) => {
    resetAdminToken()
    writeAuditLog({ resource: 'token', action: 'reset', detail: '重置管理令牌' })
    return ok(c, { token: getAdminToken() })
  })
}
