export interface Env {
  Variables: { adminToken?: string }
}

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; type: string; code: string } }

export type ProviderProtocol = 'openai' | 'anthropic'

export interface ProviderGroupRow {
  protocol: ProviderProtocol
  id: string
  name: string
  created_at: string
  updated_at: string
}

export interface ProviderRow {
  id: string
  name: string
  protocol: ProviderProtocol
  group_id: string | null
  base_url: string
  auth_json: string
  custom_headers_json: string
  proxy_url: string | null
  timeout_ms: number | null
  model_filter: string | null
  enabled: number
  created_at: string
  updated_at: string
}

export interface ProviderModelRow {
  provider_id: string
  model_id: string
  display_name: string | null
  enabled: number
  source: 'fetched' | 'manual'
  fetched_at: string | null
  created_at: string
  updated_at: string
}

export interface ModelAliasGroupRow {
  protocol: ProviderProtocol
  id: string
  name: string
  created_at: string
  updated_at: string
}

export interface ModelAliasRow {
  protocol: ProviderProtocol
  alias_name: string
  group_id: string | null
  enabled: number
  /** 思考等级配置 JSON：{"mode":"override"|"default","value":协议原生值} */
  thinking_json: string | null
  created_at: string
  updated_at: string
}

/**
 * 思考等级配置（按映射，协议原生值）：
 * - anthropic → 顶层 thinking 对象，如 {"type":"enabled","budget_tokens":2048}
 * - openai → 顶层 reasoning_effort 字符串，如 "high"
 * override 表示无条件替换/注入；default 表示仅在客户端未提供该字段时注入。
 */
export interface ThinkingConfig {
  mode: 'override' | 'default'
  value: unknown
}

export interface ModelAliasTargetRow {
  id: number
  protocol: ProviderProtocol
  alias_name: string
  provider_id: string
  model_id: string
  priority: number
  active: number
  created_at: string
  updated_at: string
}

export interface LogRow {
  id: number
  created_at: string
  client_ip: string | null
  protocol: string | null
  method: string | null
  path: string | null
  model: string | null
  provider_id: string | null
  /** 实际路由到的提供商名称（冗余存储，Provider 删除后日志仍可读） */
  provider_name: string | null
  /** 实际路由到的真实模型名（冗余存储） */
  resolved_model: string | null
  status: number | null
  latency_ms: number | null
  error_code: string | null
}

export interface AuditRow {
  id: number
  created_at: string
  resource: string
  target: string | null
  action: string
  detail: string | null
  status: number | null
}
