import { serve } from '@hono/node-server'
import { app } from './app'
import './db'
import { db, getSetting } from './db'
import { getAdminToken } from './services/auth'
import { getSettings, getLogRetentionDays } from './services/settings'
import { cleanOldLogs } from './services/logs'
import { invalidateAllDispatchers } from './proxy'

// 首次启动初始化数据库并自动生成 admin_token
getAdminToken()

// 启动时清理过期日志
const retentionDays = getLogRetentionDays()
if (retentionDays > 0) {
  const cleaned = cleanOldLogs(retentionDays)
  if (cleaned > 0) console.log(`[gateway] cleaned ${cleaned} logs older than ${retentionDays} days`)
}

// 监听配置：settings 优先（修改需重启生效），其次环境变量，最后默认值
const settings = getSettings()
// Explicit database settings win; environment variables remain useful for first boot
// and container deployments where the settings table has not been configured yet.
const HOST = getSetting('host') ?? process.env.HOST ?? settings.host
const configuredPort = getSetting('port') ?? process.env.PORT ?? settings.port
const parsedPort = Number(configuredPort)
const PORT = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535 ? parsedPort : 3000

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[gateway] listening on http://${info.address}:${info.port}`)
})

// 优雅关闭：处理 SIGTERM / SIGINT，等待在途请求完成后关闭 DB
function shutdown(signal: string) {
  console.log(`[gateway] received ${signal}, shutting down...`)
  server.close(() => {
    try {
      invalidateAllDispatchers()
      db.close()
    } catch {
      // db may already be closed
    }
    console.log('[gateway] closed')
    process.exit(0)
  })

  // 兜底：5s 后强制退出，防止卡死
  setTimeout(() => {
    console.error('[gateway] forced shutdown after 5s timeout')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
