import { existsSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { api } from './routes/api'
import { proxyRoutes } from './routes/proxy'
import { isAbortError } from './proxy'
import type { Env } from './types'

export const app = new Hono<Env>()

// 全局错误处理：客户端断连的 AbortError 静默处理（连接已关闭，写回响应无意义且产生噪音日志）
app.onError((err, c) => {
  if (isAbortError(err) || c.req.raw.signal.aborted) {
    return new Response(null, { status: 499 })
  }
  console.error('[gateway] unhandled error:', err)
  return c.json(
    { ok: false, error: { message: 'internal error', type: 'internal_error', code: 'internal_error' } },
    500 as const,
  )
})

app.route('/api', api)
app.route('/openai', proxyRoutes)
app.route('/anthropic', proxyRoutes)

// 生产环境：托管 web/dist 静态文件 + SPA fallback（相对源码定位，与启动目录无关）
const distDir = path.resolve(import.meta.dirname, '../web/dist')
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
    const filePath = path.resolve(distDir, '.' + path.normalize(urlPath))
    if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
      return c.notFound()
    }
    try {
      const stats = await stat(filePath)
      if (stats.isFile()) {
        const ext = path.extname(filePath).toLowerCase()
        const isHtml = ext === '.html'
        return new Response(createReadStream(filePath) as unknown as BodyInit, {
          headers: {
            'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
            'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
          },
        })
      }
    } catch {
      // file not found, fall through to SPA fallback
    }
    // SPA fallback：统一回 index.html
    const html = await readFile(path.join(distDir, 'index.html'))
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  })
}
