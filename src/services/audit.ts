import { db } from '../db'
import type { AuditRow } from '../types'

export type AuditResource =
  | 'auth'
  | 'provider'
  | 'provider_group'
  | 'model'
  | 'alias'
  | 'alias_group'
  | 'alias_target'
  | 'settings'
  | 'token'
  | 'backup'
  | 'logs'

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'create'
  | 'update'
  | 'delete'
  | 'test'
  | 'fetch'
  | 'import'
  | 'export'
  | 'reset'
  | 'clear'
  | 'batch_enable'
  | 'batch_delete'
  | 'activate'
  | 'reorder'

export interface AuditInput {
  resource: AuditResource
  action: AuditAction
  target?: string | null
  detail?: string | null
  status?: number
}

export interface AuditFilters {
  page: number
  pageSize: number
  resource?: string
}

const MAX_PAGE_SIZE = 10_000

function normalizePage(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(Math.trunc(value), fallback) : fallback
}

export function writeAuditLog(input: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_logs (created_at, resource, target, action, detail, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    input.resource,
    input.target ?? null,
    input.action,
    input.detail ?? null,
    input.status ?? null,
  )
}

export function listAuditLogs(filters: AuditFilters): { total: number; rows: AuditRow[] } {
  const pageSize = Math.min(normalizePage(filters.pageSize, 1), MAX_PAGE_SIZE)
  const page = normalizePage(filters.page, 1)
  const where: string[] = []
  const params: Array<string | number> = []
  if (filters.resource) {
    where.push('resource = ?')
    params.push(filters.resource)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...params) as { c: number }
  ).c
  const rows = db
    .prepare(
      `SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as AuditRow[]
  return { total, rows }
}

export function clearAuditLogs(): void {
  db.prepare('DELETE FROM audit_logs').run()
  db.prepare("DELETE FROM sqlite_sequence WHERE name = 'audit_logs'").run()
}

/** 清理超过保留天数的配置操作日志；retentionDays <= 0 表示不清理 */
export function cleanOldAuditLogs(retentionDays: number): number {
  if (retentionDays <= 0) return 0
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const result = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff)
  return result.changes
}
