export interface ApiError {
  message: string
  type: string
  code: string
}

export interface ApiOk<T> {
  ok: true
  data: T
}

export interface ApiFail {
  ok: false
  error: ApiError
}

export type ApiResp<T> = ApiOk<T> | ApiFail

export interface Provider {
  id: string
  name: string
  protocol: 'openai' | 'anthropic'
  base_url: string
  auth: Record<string, string>
  custom_headers: Record<string, string>
  proxy_url: string | null
  timeout_ms: number | null
  model_filter: string | null
  enabled: number
  created_at: string
  updated_at: string
}

export interface ProviderModel {
  provider_id: string
  model_id: string
  display_name: string | null
  enabled: number
  source: 'fetched' | 'manual'
  fetched_at: string | null
  created_at: string
  updated_at: string
  provider_name: string
  protocol: 'openai' | 'anthropic'
  provider_enabled: number
}

export interface AliasGroup {
  protocol: 'openai' | 'anthropic'
  id: string
  name: string
  created_at: string
  updated_at: string
  alias_count: number
  enabled_count: number
}

export interface AliasTarget {
  id: number
  protocol: 'openai' | 'anthropic'
  alias_name: string
  provider_id: string
  model_id: string
  priority: number
  active: number
  created_at: string
  updated_at: string
  provider_name: string
  provider_protocol: 'openai' | 'anthropic'
  provider_enabled: number
  target_enabled: number
}

export interface ModelAlias {
  protocol: 'openai' | 'anthropic'
  alias_name: string
  group_id: string | null
  group_name: string | null
  enabled: number
  provider_id: string | null
  model_id: string | null
  created_at: string
  updated_at: string
  provider_name: string | null
  provider_protocol: 'openai' | 'anthropic' | null
  provider_enabled: number
  target_enabled: number
  targets: AliasTarget[]
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

export interface BackupData {
  token: string
  settings: Record<string, string>
  providers: Array<{
    id: string
    name: string
    protocol: 'openai' | 'anthropic'
    base_url: string
    auth: Record<string, string>
    custom_headers: Record<string, string>
    proxy_url: string | null
    timeout_ms: number | null
    model_filter: string | null
    enabled: number
    created_at: string
    updated_at: string
  }>
  models: Array<{
    provider_id: string
    model_id: string
    display_name: string | null
    enabled: number
    source: 'fetched' | 'manual'
  }>
  groups: Array<{
    protocol: 'openai' | 'anthropic'
    id: string
    name: string
  }>
  aliases: Array<{
    protocol: 'openai' | 'anthropic'
    alias_name: string
    group_id: string | null
    enabled: number
    targets: Array<{
      provider_id: string
      model_id: string
      priority: number
      active: number
    }>
  }>
}
