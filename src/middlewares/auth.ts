import type { MiddlewareHandler } from 'hono'
import { verifyToken } from '../services/auth'
import type { Env } from '../types'

const TOKEN_KEYS = ['x-api-key', 'api-key'] as const

export function extractToken(c: Parameters<MiddlewareHandler<Env>>[0]): string | null {
  const authz = c.req.header('authorization')
  if (authz?.startsWith('Bearer ')) return authz.slice(7).trim()
  for (const key of TOKEN_KEYS) {
    const value = c.req.header(key)
    if (value) return value.trim()
  }
  return null
}

export const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const token = extractToken(c)
  if (!token || !verifyToken(token)) {
    return c.json(
      { ok: false, error: { message: 'invalid api key', type: 'invalid_api_key', code: 'invalid_api_key' } },
      401,
    )
  }
  c.set('adminToken', token)
  return next()
}