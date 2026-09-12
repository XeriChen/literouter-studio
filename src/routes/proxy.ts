import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { Readable } from 'node:stream'
import { authMiddleware } from '../middlewares/auth'
import { buildUpstreamHeaders, buildUpstreamUrl, HOP_BY_HOP_HEADERS } from '../providers/headers'
import { getDispatcher, isAbortError, isTimeoutError, sendToUpstream, drainBody } from '../proxy'
import { normalizeUpstreamPath } from '../proxy/path'
import {
  parseProxyBody,
  readRequestBody,
  releaseProxyBody,
  rewriteProxyBody,
  MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
} from '../proxy/body'
import { findRoute, listAliasNames } from '../services/models'
import { writeLog, updateLogResponseBytes } from '../services/logs'
import { getGlobalTimeoutMs } from '../services/settings'
import type { Env, ProviderRow } from '../types'

export const proxyRoutes = new Hono<Env>()

function proxyError(c: Context, status: number, message: string, code: string) {
  return c.json({ error: { message, type: code, code } }, status as ContentfulStatusCode)
}

/** 客户端 IP：优先 x-forwarded-for，回退到直连 socket 地址（无反向代理时也能归因）。 */
function clientIp(c: Context): string | null {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  const env = c.env as unknown as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  return env?.incoming?.socket?.remoteAddress ?? null
}

/**
 * 统计转发给客户端的响应字节数，并在流正常结束时回填日志。
 * 用 TransformStream（而非 for-await + enqueue 的手写循环）以保证背压语义不被破坏。
 */
function countResponseBytes(body: Readable, logId: number): ReadableStream<Uint8Array> {
  let total = 0
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength
      controller.enqueue(chunk)
    },
    flush() {
      updateLogResponseBytes(logId, total)
    },
  })
  return (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>).pipeThrough(counted)
}

async function forward(
  c: Context,
  provider: ProviderRow,
  upstreamPath: string,
  method: string,
  body: Uint8Array | null,
  startedAt: number,
  protocol: 'openai' | 'anthropic',
  requestedModel: string,
  resolvedModel: string,
  requestBytes: number,
) {
  const queryString = c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : ''
  const url = buildUpstreamUrl(provider.base_url, upstreamPath, queryString)
  const timeoutMs = provider.timeout_ms ?? getGlobalTimeoutMs()
  const clientSignal = c.req.raw.signal

  const res = await sendToUpstream({
    method,
    url,
    headers: buildUpstreamHeaders(provider, c.req.raw.headers),
    body,
    signal: clientSignal,
    dispatcher: getDispatcher(provider.proxy_url, timeoutMs),
  })

  // 收到上游响应头，立即写日志（latency = 首包耗时）
  const headerAt = Date.now()
  const logId = writeLog({
    client_ip: clientIp(c),
    protocol,
    method,
    path: c.req.path,
    model: requestedModel,
    provider_id: provider.id,
    provider_name: provider.name,
    resolved_model: resolvedModel,
    status: res.status,
    latency_ms: headerAt - startedAt,
    request_bytes: requestBytes,
  })

  // 上游 5xx：包装为 502 upstream_error；4xx：原样透传
  if (res.status >= 500) {
    await drainBody(res.body)
    return proxyError(c, 502, `upstream error (HTTP ${res.status})`, 'upstream_error')
  }

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(k) || k === 'content-length') return
    headers[key] = value
  })
  if (!headers['content-type']) headers['content-type'] = 'application/json'

  return new Response(countResponseBytes(res.body, logId) as unknown as BodyInit, { status: res.status, headers })
}

async function logAndFail(
  c: Context,
  protocol: 'openai' | 'anthropic',
  path: string,
  method: string,
  model: string | null,
  startedAt: number,
  status: number,
  code: string,
  message: string,
) {
  writeLog({
    client_ip: clientIp(c),
    protocol,
    method,
    path,
    model,
    status,
    latency_ms: Date.now() - startedAt,
    error_code: code,
  })
  return proxyError(c, status, message, code)
}

proxyRoutes.use('*', authMiddleware)

proxyRoutes.all('*', async (c) => {
  const startedAt = Date.now()
  const path = c.req.path
  const protocol: 'openai' | 'anthropic' = path.startsWith('/openai') ? 'openai' : 'anthropic'
  // 去掉 /openai|/anthropic 前缀后，归一化端点的 v1 版本段：缺失自动补齐、多重自动去重
  const upstreamPath = normalizeUpstreamPath(path.replace(/^\/(openai|anthropic)/, ''))
  let requestedModel: string | null = null

  try {
    // GET /v1/models：只返回已建立映射的模型名（未建映射不可见、不可调用）
    if (c.req.method === 'GET' && upstreamPath === '/v1/models') {
      const aliases = listAliasNames(protocol)
      const data = aliases.map((name) => ({ id: name, object: 'model', owned_by: 'gateway' }))
      return c.json({ object: 'list', data })
    }

    if (c.req.method !== 'POST') {
      return c.json(
        { error: { message: 'method not allowed', type: 'method_not_allowed', code: 'method_not_allowed' } },
        405,
      )
    }

    const parsed = parseProxyBody(await readRequestBody(c.req.raw, MAX_REQUEST_BODY_BYTES))
    if (!parsed) {
      return logAndFail(c, protocol, path, 'POST', null, startedAt, 400, 'invalid_request_body', 'invalid request body: missing model')
    }
    const requestBytes = parsed.bytes.length
    const model = parsed.model
    requestedModel = model

    const route = findRoute(protocol, model)
    if (route.kind !== 'ok') {
      // 请求即将失败返回，先释放持有的原始 body
      releaseProxyBody(parsed)
      const disabled = route.kind === 'provider_disabled'
      return logAndFail(c, protocol, path, 'POST', model, startedAt, disabled ? 503 : 404, disabled ? 'provider_disabled' : 'model_not_found', disabled ? 'provider disabled' : 'model not found')
    }

    // 映射名 -> 真实模型名，并按映射配置定点改写思考等级字段，其余字节原样保留
    const outBody = rewriteProxyBody(parsed, route.model.model_id, route.thinking)
    // 等待上游响应可能长达数十秒，期间只保留改写后的 outBody，不再持有原始请求体
    releaseProxyBody(parsed)

    return await forward(c, route.provider, upstreamPath, 'POST', outBody, startedAt, protocol, model, route.model.model_id, requestBytes)
  } catch (err) {
    if (isAbortError(err) || c.req.raw.signal.aborted) {
      throw err
    }
    if (err instanceof RequestBodyTooLargeError) {
      return logAndFail(c, protocol, path, c.req.method, requestedModel, startedAt, 413, 'invalid_request_body', 'request body too large (max 50MB)')
    }
    const timeout = isTimeoutError(err)
    return logAndFail(
      c,
      protocol,
      path,
      c.req.method,
      requestedModel,
      startedAt,
      timeout ? 504 : 502,
      timeout ? 'upstream_timeout' : 'upstream_error',
      timeout ? 'upstream timeout' : err instanceof Error ? err.message : 'upstream error',
    )
  }
})
