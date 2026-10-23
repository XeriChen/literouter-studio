import { existsSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 端口可整体让位：PORT 决定 vite 的代理目标（网关端口），VITE_PORT 决定 vite 自身端口。
// 代理目标解析顺序与 src/server.ts 一致：PORT > 库里 settings.port > 3000。这样开发时
// 后端在库中端口（本机 3013）而 /api 不会误代理到 3000 或其他服务。只影响 dev server；
// `pnpm build:web` 不读取 server 字段，生产构建产物不受影响。
function portFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback
}

function gatewayPort(): number {
  const fromEnv = portFromEnv('PORT', 0)
  if (fromEnv > 0) return fromEnv

  const dataDir = process.env.GATEWAY_DATA_DIR ?? path.join(process.cwd(), 'data')
  const dbPath = path.join(dataDir, 'gateway.db')
  if (!existsSync(dbPath)) return 3000
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('port') as { value?: string } | undefined
    db.close()
    const port = Number(row?.value)
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 3000
  } catch {
    // 库不可读时回退默认值；端口冲突由 scripts/check-ports.ts 在启动前拦截
    return 3000
  }
}

const gatewayOrigin = `http://127.0.0.1:${gatewayPort()}`

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'web/src'),
    },
  },
  server: {
    port: portFromEnv('VITE_PORT', 5173),
    // 端口被占用时直接失败，不静默切换到 5174 等端口，避免和实际访问地址不一致
    strictPort: true,
    proxy: {
      '/api': gatewayOrigin,
      '/openai': gatewayOrigin,
      '/anthropic': gatewayOrigin,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
