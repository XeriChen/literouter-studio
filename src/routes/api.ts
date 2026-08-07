import { Hono } from 'hono'
import { authMiddleware } from '../middlewares/auth'
import type { Env } from '../types'

export const api = new Hono<Env>()

api.post('/login', (c) => {
  // TODO: 校验 admin_token，成功后返回 token
  return c.json({ ok: true, data: { token: '' } })
})

api.use('*', authMiddleware)

api.get('/me', (c) => {
  // TODO: 管理端 API 骨架
  return c.json({ ok: true, data: {} })
})