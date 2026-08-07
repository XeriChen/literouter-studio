import type { MiddlewareHandler } from 'hono'
import type { Env } from '../types'

export const TOKEN_KEYS = ['authorization', 'x-api-key', 'api-key'] as const

export const authMiddleware: MiddlewareHandler<Env> = (c, next) => {
  // TODO: 按优先级从 Authorization: Bearer / x-api-key / api-key 提取并校验 admin_token
  // 校验失败时返回 401 { error: { type: 'invalid_api_key' } }
  return next()
}