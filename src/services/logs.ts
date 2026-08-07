import { db } from '../db'
import type { LogRow } from '../types'

export function listLogs(params: { page: number; pageSize: number }): { total: number; rows: LogRow[] } {
  const { page, pageSize } = params
  const offset = (page - 1) * pageSize
  const total = (db.prepare('SELECT COUNT(*) AS c FROM logs').get() as { c: number }).c
  const rows = db
    .prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(pageSize, offset) as LogRow[]
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