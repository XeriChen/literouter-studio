import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const dataDir = path.resolve(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })

export const db = new Database(path.join(dataDir, 'gateway.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

/**
 * 开发阶段当前 schema 基线（v11）。旧数据库允许直接删除 data/gateway.db 后重建，
 * 因此这里不保留历史 v1-v5 迁移分支；仅保留 v6 → v7 至 v10 → v11 的守卫式加列/建表。
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
  provider_name TEXT,
  resolved_model TEXT,
  status INTEGER,
  latency_ms INTEGER,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  balance REAL,
  currency TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE (provider_id, day_key),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
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
// v7 → v8：为既有数据库补日志的 provider_name / resolved_model 列（守卫式，重复执行无副作用）
if (!db.prepare("SELECT 1 FROM pragma_table_info('logs') WHERE name = 'provider_name'").get()) {
  db.prepare('ALTER TABLE logs ADD COLUMN provider_name TEXT').run()
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('logs') WHERE name = 'resolved_model'").get()) {
  db.prepare('ALTER TABLE logs ADD COLUMN resolved_model TEXT').run()
}

// v8 → v9：密钥加密 + 路由模式（守卫式）
if (!db.prepare("SELECT 1 FROM pragma_table_info('providers') WHERE name = 'auth_json_encrypted'").get()) {
  db.prepare('ALTER TABLE providers ADD COLUMN auth_json_encrypted TEXT').run()
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('model_aliases') WHERE name = 'routing_config_json'").get()) {
  db.prepare('ALTER TABLE model_aliases ADD COLUMN routing_config_json TEXT').run()
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('model_alias_targets') WHERE name = 'weight'").get()) {
  db.prepare('ALTER TABLE model_alias_targets ADD COLUMN weight INTEGER NOT NULL DEFAULT 100').run()
}

// v9 → v10：New API / Sub2API 上游类型支持（守卫式）
if (!db.prepare("SELECT 1 FROM pragma_table_info('providers') WHERE name = 'upstream_type'").get()) {
  db.prepare("ALTER TABLE providers ADD COLUMN upstream_type TEXT CHECK (upstream_type IN ('newapi', 'sub2api') OR upstream_type IS NULL)").run()
}

// 日志补充请求/响应字节数：用于把内存增长与具体请求体/响应体大小对应起来
if (!db.prepare("SELECT 1 FROM pragma_table_info('logs') WHERE name = 'request_bytes'").get()) {
  db.prepare('ALTER TABLE logs ADD COLUMN request_bytes INTEGER').run()
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('logs') WHERE name = 'response_bytes'").get()) {
  db.prepare('ALTER TABLE logs ADD COLUMN response_bytes INTEGER').run()
}

// v10 → v11：被动用量统计（prompt/completion/total tokens）与重试序号；余额日快照
if (!db.prepare("SELECT 1 FROM pragma_table_info('logs') WHERE name = 'prompt_tokens'").get()) {
  db.prepare('ALTER TABLE logs ADD COLUMN prompt_tokens INTEGER').run()
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('logs') WHERE name = 'completion_tokens'").get()) {
  db.prepare('ALTER TABLE logs ADD COLUMN completion_tokens INTEGER').run()
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('logs') WHERE name = 'total_tokens'").get()) {
  db.prepare('ALTER TABLE logs ADD COLUMN total_tokens INTEGER').run()
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('logs') WHERE name = 'attempt'").get()) {
  db.prepare('ALTER TABLE logs ADD COLUMN attempt INTEGER').run()
}

db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (11)').run()

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
