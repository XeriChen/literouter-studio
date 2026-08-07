import { serve } from '@hono/node-server'
import { app } from './app'
import './db'
import { getAdminToken } from './services/auth'
import { getSettings } from './services/settings'

// 首次启动初始化数据库并自动生成 admin_token
getAdminToken()

// 监听配置：settings 优先（修改需重启生效），其次环境变量，最后默认值
const settings = getSettings()
const HOST = settings.host || process.env.HOST || '0.0.0.0'
const PORT = Number(settings.port || process.env.PORT || 3000)

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[gateway] listening on http://${info.address}:${info.port}`)
})