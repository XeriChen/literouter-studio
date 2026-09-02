import { serve } from '@hono/node-server'
import { writeHeapSnapshot } from 'node:v8'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
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

// RSS 看门狗：周期性采样内存占用，越过高水位时手动写堆快照，便于事后定位泄漏点。
// 与 node --heapsnapshot-near-heap-limit 互为冗余——即便未加该 flag 也能留快照。
// 阈值通过环境变量 GATEWAY_RSS_SNAPSHOT_BYTES 配置，默认 1.5 GiB；设 0 关闭。
function startRssWatchdog() {
  const threshold = Number(process.env.GATEWAY_RSS_SNAPSHOT_BYTES ?? 1.5 * 1024 * 1024 * 1024)
  if (!Number.isFinite(threshold) || threshold <= 0) return
  let lastShot = 0
  const snapshotDir = join(process.cwd(), 'data')
  setInterval(() => {
    const rss = process.memoryUsage().rss
    if (rss > threshold) {
      const now = Date.now()
      // 至少间隔 5 分钟，避免内存高位期疯狂刷快照
      if (now - lastShot > 5 * 60 * 1000) {
        lastShot = now
        try {
          if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true })
          const file = writeHeapSnapshot(join(snapshotDir, `gateway-rss-${now}.heapsnapshot`))
          console.error(`[gateway] RSS ${Math.round(rss / 1024 / 1024)}MiB exceeded watchdog threshold, heap snapshot written to ${file}`)
        } catch (err) {
          console.error('[gateway] failed to write heap snapshot:', err)
        }
      }
    }
  }, 30_000).unref()
}

startRssWatchdog()
