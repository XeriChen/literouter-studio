import { db } from '../db'
import type { ProviderProtocol, ProviderRow } from '../types'

export function listProviders(): ProviderRow[] {
  return db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all() as ProviderRow[]
}

export function getProvider(id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
}

export function createProvider(input: {
  id: string
  name: string
  protocol: ProviderProtocol
  base_url: string
  auth_json: string
  custom_headers_json: string
  proxy_url: string | null
  timeout_ms: number | null
}): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO providers (id, name, protocol, base_url, auth_json, custom_headers_json, proxy_url, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.protocol,
    input.base_url,
    input.auth_json,
    input.custom_headers_json,
    input.proxy_url,
    input.timeout_ms,
    now,
    now,
  )
}

export function updateProvider(id: string, patch: Partial<ProviderRow>): void {
  const now = new Date().toISOString()
  db.prepare(`UPDATE providers SET updated_at = ? WHERE id = ?`).run(now, id)
  // TODO: 动态 SET 字段
}

export function deleteProvider(id: string): void {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id)
}

export function setProviderEnabled(id: string, enabled: number): void {
  db.prepare('UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?').run(
    enabled,
    new Date().toISOString(),
    id,
  )
}