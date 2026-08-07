import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { authMiddleware } from '../middlewares/auth'
import { buildUpstreamHeaders, buildUpstreamUrl, HOP_BY_HOP_HEADERS } from '../providers/headers'
import { getDispatcher, isAbortError, isTimeoutError, sendToUpstream, drainBody } from '../proxy'
import { findRoute } from '../services/models'
import { writeLog } from '../services/logs'
import { getGlobalTimeoutMs } from '../services/settings'
import type { Env, ProviderRow } from '../types'

export const proxyRoutes = new Hono<Env>()

const MAX_BODY_BYTES = 50 * 1024 * 1024

const EMPTY_LOG = { model: null, providerId: null, headerAt: null, errorCode: null, status: null }

function proxyError(c: Context, status: number, message: string, code: string) {
  return c.json({ error: { message, type: code, code } }, status as ContentfulStatusCode)
}

async function forward(
  c: Context,
  provider: ProviderRow,
  upstreamPath: string,
  method: string,
  body: Uint8Array | null,
  startedAt: number,
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
  const proxyLog = c.get('proxyLog') ?? EMPTY_LOG
  c.set('proxyLog', { ...proxyLog, headerAt, status: res.status })
  writeLog({
    client_ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
    protocol: c.get('_protocol'),
    method,
    path: c.req.path,
    model: proxyLog.model ?? null,
    provider_id: provider.id,
    status: res.status,
    latency_ms: headerAt - startedAt,
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

  return new Response(res.body as unknown as BodyInit, { status: res.status, headers })
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
    client_ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
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
  const upstreamPath = path.replace(/^\/(openai|anthropic)/, '')
  c.set('proxyLog', EMPTY_LOG)
  c.set('_protocol', protocol)

  // OpenAI 入口严格限定 /openai/v1/*：不带 /v1 的路径一律 404
  if (protocol === 'openai' && !upstreamPath.startsWith('/v1/')) {
    return logAndFail(c, protocol, path, c.req.method, null, startedAt, 404, 'not_found', 'not found')
  }

  try {
    // GET /v1/models：返回本地已启用的模型列表（不转发上游）
    if (c.req.method === 'GET' && upstreamPath === '/v1/models') {
      const { listEnabledModels } = await import('../services/models')
      const models = listEnabledModels(protocol)
      if (!models.length) {
        return logAndFail(c, protocol, path, 'GET', null, startedAt, 404, 'model_not_found', 'no enabled models')
      }
      const data = models.map((m) => ({ id: m.model_id, object: 'model', owned_by: 'gateway' }))
      return c.json({ object: 'list', data })
    }

    if (c.req.method !== 'POST') {
      return c.json(
        { error: { message: 'method not allowed', type: 'method_not_allowed', code: 'method_not_allowed' } },
        405,
      )
    }

    const raw = await c.req.arrayBuffer()
    if (raw.byteLength > MAX_BODY_BYTES) {
      return proxyError(c, 413, 'request body too large (max 50MB)', 'invalid_request_body')
    }

    const bodyBytes = new Uint8Array(raw)
    let model: string | null = null
    try {
      const json = JSON.parse(new TextDecoder().decode(bodyBytes)) as { model?: string }
      model = typeof json.model === 'string' ? json.model : null
    } catch {
      model = null
    }
    if (!model) {
      return proxyError(c, 400, 'invalid request body: missing model', 'invalid_request_body')
    }

    const route = findRoute(protocol, model)
    if (route.kind !== 'ok') {
      const disabled = route.kind === 'provider_disabled'
      return logAndFail(c, protocol, path, 'POST', model, startedAt, disabled ? 503 : 404, disabled ? 'provider_disabled' : 'model_not_found', disabled ? 'provider disabled' : 'model not found')
    }

    c.set('proxyLog', { ...(c.get('proxyLog') ?? EMPTY_LOG), model })
    return forward(c, route.provider, upstreamPath, 'POST', bodyBytes, startedAt)
  } catch (err) {
    if (isAbortError(err) || c.req.raw.signal.aborted) {
      throw err
    }
    const timeout = isTimeoutError(err)
    return logAndFail(
      c,
      protocol,
      path,
      c.req.method,
      c.get('proxyLog')?.model ?? null,
      startedAt,
      timeout ? 504 : 502,
      timeout ? 'upstream_timeout' : 'upstream_error',
      timeout ? 'upstream timeout' : err instanceof Error ? err.message : 'upstream error',
    )
  }
})