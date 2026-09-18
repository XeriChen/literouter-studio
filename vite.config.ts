import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 端口可整体让位：PORT 决定 vite 的代理目标（网关端口），VITE_PORT 决定 vite 自身端口。
// 本机 3000 是 systemd 托管的生产网关（literouter.service），worktree 开发实例用
// `PORT=3001 VITE_PORT=5174 pnpm dev` 一起让位，避免撞生产端口或把 /api 代理到生产。
// 只影响 dev server；`pnpm build:web` 不读取 server 字段，生产构建产物不受影响。
function portFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback
}

const gatewayPort = portFromEnv('PORT', 3000)
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`

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
