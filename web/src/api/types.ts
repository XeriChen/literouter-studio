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
  group_id: string | null
  base_url: string
  auth: Record<string, string | { header_name: string; format: string }>
  custom_headers: Record<string, string>
  proxy_url: string | null
  timeout_ms: number | null
  model_filter: string | null
  enabled: number
  upstream_type: 'newapi' | 'sub2api' | null
  created_at: string
  updated_at: string
}

export interface BalanceResult {
  success: boolean
  balance: number | null
  currency: string | null
  balances: Array<{ label: string; balance: number; currency: string }>
  /** 上游密钥无限额：balance 为 null，balances 仅可能含「已用」用量项 */
  unlimited: boolean
  available: boolean | null
  status_code: number | null
  fetched_at: string
  error: string | null
  expires_at: string | null
}

export interface ProviderGroup {
  protocol: 'openai' | 'anthropic'
  id: string
  name: string
  created_at: string
  updated_at: string
  provider_count: number
  enabled_count: number
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
  weight: number
  created_at: string
  updated_at: string
  provider_name: string
  provider_protocol: 'openai' | 'anthropic'
  provider_enabled: number
  target_enabled: number
}

/** 路由配置（与后端 routing_config_schema 一致） */
export interface RoutingConfig {
  mode: 'single' | 'weighted' | 'failover'
  affinity_seconds?: number
  max_attempts?: number
  cooldown_seconds?: number
}

export interface ThinkingConfig {
  mode: 'override' | 'default'
  /** anthropic：thinking 对象；openai：reasoning_effort 字符串 */
  value: unknown
}

export interface ModelAlias {
  protocol: 'openai' | 'anthropic'
  alias_name: string
  group_id: string | null
  group_name: string | null
  enabled: number
  /** 思考等级配置 JSON 字符串（ThinkingConfig | null） */
  thinking_json: string | null
  /** 路由配置 JSON 字符串（RoutingConfig | null，null = single 默认） */
  routing_config_json: string | null
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
  provider_name: string | null
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

export interface BackupData {
  token: string
  settings: Record<string, string>
  providers: Array<{
    id: string
    name: string
    protocol: 'openai' | 'anthropic'
    group_id: string | null
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
  provider_groups: Array<{
    protocol: 'openai' | 'anthropic'
    id: string
    name: string
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
    thinking: ThinkingConfig | null
    targets: Array<{
      provider_id: string
      model_id: string
      priority: number
      active: number
    }>
  }>
}
