import type { Env } from '../types'

export interface UpstreamRequest {
  method: string
  url: string
  headers: Headers
  body: Uint8Array
  provider: {
    proxy_url: string | null
    timeout_ms: number | null
  }
  clientSignal: AbortSignal
  variable: Env['Variables']
}

export interface UpstreamResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

export async function sendToUpstream(_req: UpstreamRequest): Promise<UpstreamResponse> {
  // TODO: 使用 undici 发起上游请求。
  // 关键陷阱（详见 plan.md §5.4）：
  //   - connectTimeout/headersTimeout = timeout；bodyTimeout 必须显式设为 0（防长流被掐断）
  //   - ProxyAgent 按 proxy_url 缓存复用
  //   - 监听 clientSignal，客户端断开立即 abort 上游请求
  throw new Error('proxy not implemented')
}