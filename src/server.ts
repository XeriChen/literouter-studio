import { serve } from '@hono/node-server'
import { app } from './app'
import './db'
import { getAdminToken } from './services/auth'

const HOST = process.env.HOST ?? '0.0.0.0'
const PORT = Number(process.env.PORT ?? 3000)

// 首次启动初始化数据库并自动生成 admin_token
getAdminToken()

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[gateway] listening on http://${info.address}:${info.port}`)
})