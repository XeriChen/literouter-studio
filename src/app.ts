import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { api } from './routes/api'
import { proxyRoutes } from './routes/proxy'
import { errorMiddleware } from './middlewares/error'
import type { Env } from './types'

export const app = new Hono<Env>()

app.use('*', errorMiddleware)

app.route('/api', api)
app.route('/openai', proxyRoutes)
app.route('/anthropic', proxyRoutes)

// 生产环境：托管 web/dist 静态文件 + SPA fallback
const distDir = path.resolve(process.cwd(), 'web/dist')
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

if (existsSync(distDir)) {
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api') || c.req.path.startsWith('/openai') || c.req.path.startsWith('/anthropic')) {
      return c.notFound()
    }
    const urlPath = c.req.path === '/' ? '/index.html' : c.req.path
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
    const filePath = path.join(distDir, safePath)
    if (urlPath !== '/index.html' && existsSync(filePath) && (!filePath.startsWith(distDir) && !existsSync(filePath))) {
      return c.notFound()
    }
    if (existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase()
      return new Response(readFileSync(filePath), {
        headers: { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' },
      })
    }
    // SPA fallback：统一回 index.html
    return new Response(readFileSync(path.join(distDir, 'index.html')), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  })
}