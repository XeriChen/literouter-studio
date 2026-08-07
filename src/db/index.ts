import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const dataDir = path.resolve(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })

export const db = new Database(path.join(dataDir, 'gateway.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  base_url TEXT NOT NULL,
  auth_json TEXT NOT NULL,
  custom_headers_json TEXT NOT NULL DEFAULT '{}',
  proxy_url TEXT,
  timeout_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_models (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('fetched', 'manual')),
  fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  client_ip TEXT,
  protocol TEXT,
  method TEXT,
  path TEXT,
  model TEXT,
  provider_id TEXT,
  status INTEGER,
  latency_ms INTEGER,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_models_model_id_protocol ON provider_models(model_id, enabled);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
`

db.exec(SCHEMA_V1)
db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (1)').run()

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}