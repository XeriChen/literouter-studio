export interface Env {
  Variables: { adminToken?: string }
}

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; type: string; code: string } }

export type ProviderProtocol = 'openai' | 'anthropic'

export interface ProviderRow {
  id: string
  name: string
  protocol: ProviderProtocol
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

export interface ModelAliasRow {
  protocol: ProviderProtocol
  alias_name: string
  provider_id: string
  model_id: string
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
