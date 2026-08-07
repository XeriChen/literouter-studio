import { Agent, ProxyAgent, request, type Dispatcher } from 'undici'
import type { Readable } from 'node:stream'

interface DispatcherOptions {
  connectTimeout: number
  headersTimeout: number
  bodyTimeout: number
}

const dispatcherCache = new Map<string, Dispatcher>()

/** 按 (proxy_url, timeout_ms) 缓存复用 dispatcher；时间戳口径与 plan.md §5.4 一致（bodyTimeout 恒为 0） */
export function getDispatcher(proxyUrl: string | null | undefined, timeoutMs: number): Dispatcher {
  const timeout = timeoutMs || 0
  const opts: DispatcherOptions = { connectTimeout: timeout, headersTimeout: timeout, bodyTimeout: 0 }
  const key = `${proxyUrl ?? 'direct'}|${timeout}`
  let dispatcher = dispatcherCache.get(key)
  if (!dispatcher) {
    dispatcher = proxyUrl?.trim() ? new ProxyAgent({ uri: proxyUrl, ...opts }) : new Agent(opts)
    dispatcherCache.set(key, dispatcher)
  }
  return dispatcher
}

/** 关闭并移除所有缓存的 dispatcher（用于 Provider 更新/删除时释放旧连接池） */
export function invalidateAllDispatchers(): void {
  for (const dispatcher of dispatcherCache.values()) {
    try {
      ;(dispatcher as Agent & { close?: () => Promise<void> }).close?.()
    } catch {
      // ignore
    }
  }
  dispatcherCache.clear()
}

export interface UpstreamRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: Uint8Array | null
  dispatcher: Dispatcher
  signal?: AbortSignal
}

export interface UpstreamResponse {
  status: number
  headers: Headers
  body: Readable
}

/** 排空（丢弃）上游响应体 */
export async function drainBody(body: Readable | null | undefined): Promise<void> {
  if (!body) return
  const withDump = body as Readable & { dump?: () => Promise<void> }
  try {
    if (withDump.dump) await withDump.dump()
    else body.destroy()
  } catch {
    body.destroy()
  }
}

export async function sendToUpstream(req: UpstreamRequest): Promise<UpstreamResponse> {
  const res = await request(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: req.signal,
    dispatcher: req.dispatcher,
  })
  const h = new Headers()
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue
    h.set(k, Array.isArray(v) ? v.join(', ') : String(v))
  }
  return {
    status: res.statusCode,
    headers: h,
    body: res.body,
  }
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as Error & { code?: string }).code : undefined
}

export function isTimeoutError(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || (err instanceof Error && err.name === 'TimeoutError')
}

export function isAbortError(err: unknown): boolean {
  const code = errorCode(err)
  return (err instanceof Error && err.name === 'AbortError') || code === 'UND_ERR_ABORTED'
}