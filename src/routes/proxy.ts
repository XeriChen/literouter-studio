import { Hono } from 'hono'
import { authMiddleware } from '../middlewares/auth'
import type { Env } from '../types'

export const proxyRoutes = new Hono<Env>()

proxyRoutes.use('*', authMiddleware)

proxyRoutes.all('*', (c) => {
  // TODO: 代理转发管线（读取 body -> 提取 model -> 路由 -> 构造上游请求 -> 透传响应）
  return c.json(
    {
      error: {
        message: 'proxy not implemented',
        type: 'not_implemented',
        code: 'not_implemented',
      },
    },
    501,
  )
})