import type { MiddlewareHandler } from 'hono'
import type { Env } from '../types'

export const logMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  // TODO: 在每个请求完成后写入 logs 表
  await next()
}