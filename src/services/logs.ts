import { db } from '../db'
import type { LogRow } from '../types'

export interface LogFilters {
  page: number
  pageSize: number
  protocol?: string
  provider_id?: string
  model?: string
  status?: number
}

const MAX_PAGE_SIZE = 10_000

export function listLogs(filters: LogFilters): { total: number; rows: LogRow[] } {
  const pageSize = Math.min(Math.max(filters.pageSize, 1), MAX_PAGE_SIZE)
  const page = Math.max(filters.page, 1)
  const where: string[] = []
  const params: Array<string | number> = []
  if (filters.protocol) {
    where.push('protocol = ?')
    params.push(filters.protocol)
  }
  if (filters.provider_id) {
    where.push('provider_id = ?')
    params.push(filters.provider_id)
  }
  if (filters.model) {
    where.push('model = ?')
    params.push(filters.model)
  }
  if (filters.status !== undefined) {
    where.push('status = ?')
    params.push(filters.status)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM logs ${whereSql}`).get(...params) as { c: number }
  ).c
  const rows = db
    .prepare(
      `SELECT * FROM logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as LogRow[]
  return { total, rows }
}

export function writeLog(row: Partial<LogRow>): void {
  db.prepare(
    `INSERT INTO logs (created_at, client_ip, protocol, method, path, model, provider_id, status, latency_ms, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.created_at ?? new Date().toISOString(),
    row.client_ip ?? null,
    row.protocol ?? null,
    row.method ?? null,
    row.path ?? null,
    row.model ?? null,
    row.provider_id ?? null,
    row.status ?? null,
    row.latency_ms ?? null,
    row.error_code ?? null,
  )
}

export function clearLogs(): void {
  db.prepare('DELETE FROM logs').run()
  db.prepare("DELETE FROM sqlite_sequence WHERE name = 'logs'").run()
}