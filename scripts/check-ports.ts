/**
 * 启动前端口预检。
 *
 * 开发与测试实例必须使用与部署分离的端口，且每次启动前先确认端口空闲：
 * 被占用时直接失败，而不是让 tsx / vite 静默换端口，或把请求代理到别的服务。
 *
 * 用法：
 *   tsx scripts/check-ports.ts              # 后端 + Vite
 *   tsx scripts/check-ports.ts --server     # 仅后端
 *   tsx scripts/check-ports.ts --web        # 仅 Vite
 *   tsx scripts/check-ports.ts --port=8080  # 额外检查指定端口（可重复）
 *
 * 后端端口解析顺序与 src/server.ts 一致：库中 settings.port > PORT > 3000；
 * Vite 端口取 VITE_PORT，默认 5173。库以只读方式打开，不存在时不创建。
 */
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import Database from 'better-sqlite3'

const DEFAULT_PORT = 3000
const DEFAULT_VITE_PORT = 5173
const PROBE_HOST = '127.0.0.1'

interface Target {
  label: string
  port: number
}

type Probe = { state: 'free' } | { state: 'busy' } | { state: 'error'; message: string }

function parsePort(value: unknown): number | null {
  const port = Number(value)
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function portFromEnv(name: string): number | null {
  const raw = process.env[name]
  return raw ? parsePort(raw) : null
}

function portFromDb(): number | null {
  const dataDir = process.env.GATEWAY_DATA_DIR ?? path.join(process.cwd(), 'data')
  const dbPath = path.join(dataDir, 'gateway.db')
  if (!existsSync(dbPath)) return null

  let db: InstanceType<typeof Database> | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('port') as { value?: string } | undefined
    return parsePort(row?.value)
  } catch {
    return null
  } finally {
    db?.close()
  }
}

function resolveServerPort(): number {
  return portFromDb() ?? portFromEnv('PORT') ?? DEFAULT_PORT
}

function resolveVitePort(): number {
  return portFromEnv('VITE_PORT') ?? DEFAULT_VITE_PORT
}

function probePort(port: number): Promise<Probe> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve({ state: 'busy' })
      else resolve({ state: 'error', message: error.message })
    })
    server.once('listening', () => {
      server.close(() => resolve({ state: 'free' }))
    })
    server.listen({ port, host: PROBE_HOST, exclusive: true })
  })
}

function hintFor(port: number): string {
  return process.platform === 'win32'
    ? `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object OwningProcess`
    : `ss -ltnp | grep ':${port}'`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const rawExplicit = args.filter((arg) => arg.startsWith('--port=')).map((arg) => arg.slice('--port='.length))
  const explicit: number[] = []
  for (const raw of rawExplicit) {
    const port = parsePort(raw)
    if (port === null) {
      console.error(`[端口检查] --port=${raw} 不是 1-65535 的端口`)
      process.exitCode = 1
      return
    }
    explicit.push(port)
  }

  const scoped = args.includes('--server') || args.includes('--web')
  const targets: Target[] = []
  if (!scoped || args.includes('--server')) targets.push({ label: '后端', port: resolveServerPort() })
  if (!scoped || args.includes('--web')) targets.push({ label: 'Vite', port: resolveVitePort() })
  for (const port of explicit) targets.push({ label: '自定义', port })

  // 同一端口只探测一次，保留首个标签
  const unique = new Map<number, Target>()
  for (const target of targets) {
    if (!unique.has(target.port)) unique.set(target.port, target)
  }

  const busy: Target[] = []
  for (const { label, port } of unique.values()) {
    const result = await probePort(port)
    if (result.state === 'free') {
      console.log(`[端口检查] ${label} ${port} 空闲`)
    } else if (result.state === 'busy') {
      console.error(`[端口检查] ${label} ${port} 已被占用`)
      busy.push({ label, port })
    } else {
      console.error(`[端口检查] ${label} ${port} 无法探测：${result.message}`)
      busy.push({ label, port })
    }
  }

  if (busy.length === 0) {
    console.log('[端口检查] 通过')
    return
  }

  console.error('')
  console.error('启动已中止：请先停止占用进程，或改用其他端口（PORT / VITE_PORT）后重试。')
  for (const { port } of busy) {
    console.error(`  端口 ${port} 排查：${hintFor(port)}`)
  }
  console.error('  端口规划：部署 3000；本机开发/测试后端 3013、Vite 5173。')
  process.exitCode = 1
}

await main()
