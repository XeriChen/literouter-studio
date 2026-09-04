import type { FullConfig } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

/** 仓库根目录下的开发库（锚定到本文件位置，不依赖进程 cwd） */
const DB_PATH = fileURLToPath(new URL('../../data/gateway.db', import.meta.url))

/**
 * E2E_GATEWAY_TOKEN 未设置时，从本地开发库 data/gateway.db 读取 admin_token 作为回退。
 * 库不存在、表缺失或无 token（如 CI 全新环境）时静默跳过，登录类测试照旧 test.skip。
 */
export default function globalSetup(_config: FullConfig): void {
  if (process.env.E2E_GATEWAY_TOKEN) return
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const row = db
      .prepare("select value from settings where key = 'admin_token'")
      .get() as { value?: string } | undefined
    db.close()
    if (row?.value) process.env.E2E_GATEWAY_TOKEN = row.value
  } catch {
    // 忽略：无法回退时由各测试内的 test.skip 门控兜底
  }
}
