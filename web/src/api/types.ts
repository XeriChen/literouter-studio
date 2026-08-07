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
}