import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const dataDir = path.resolve(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })

export const db = new Database(path.join(dataDir, 'gateway.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

/**
 * 开发阶段当前 schema 基线（v7）。旧数据库允许直接删除 data/gateway.db 后重建，
 * 因此这里不保留历史 v1-v5 迁移分支；仅保留 v6 → v7 的一步守卫式加列。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS provider_groups (
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (protocol, id),
  UNIQUE (protocol, name)
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  group_id TEXT,
  base_url TEXT NOT NULL,
  auth_json TEXT NOT NULL,
  custom_headers_json TEXT NOT NULL DEFAULT '{}',
  proxy_url TEXT,
  timeout_ms INTEGER,
  model_filter TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (protocol, group_id) REFERENCES provider_groups(protocol, id)
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  resource TEXT NOT NULL,
  target TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  status INTEGER
);

CREATE TABLE IF NOT EXISTS model_alias_groups (
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (protocol, id),
  UNIQUE (protocol, name)
);

CREATE TABLE IF NOT EXISTS model_aliases (
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  alias_name TEXT NOT NULL,
  group_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  thinking_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (protocol, alias_name),
  FOREIGN KEY (protocol, group_id) REFERENCES model_alias_groups(protocol, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS model_alias_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  alias_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (protocol, alias_name, provider_id, model_id),
  FOREIGN KEY (protocol, alias_name) REFERENCES model_aliases(protocol, alias_name) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (provider_id, model_id) REFERENCES provider_models(provider_id, model_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_models_model_id_protocol ON provider_models(model_id, enabled);
CREATE INDEX IF NOT EXISTS idx_providers_group ON providers(protocol, group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alias_targets_priority ON model_alias_targets(protocol, alias_name, priority, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_active_target ON model_alias_targets(protocol, alias_name) WHERE active = 1;
`)

// v6 → v7：为既有数据库补 thinking_json 列（守卫式，重复执行无副作用）
if (!db.prepare("SELECT 1 FROM pragma_table_info('model_aliases') WHERE name = 'thinking_json'").get()) {
  db.prepare('ALTER TABLE model_aliases ADD COLUMN thinking_json TEXT').run()
}
db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (7)').run()

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
