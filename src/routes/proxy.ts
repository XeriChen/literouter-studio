import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { Readable } from 'node:stream'
import { authMiddleware } from '../middlewares/auth'
import { buildUpstreamHeaders, buildUpstreamUrl, HOP_BY_HOP_HEADERS } from '../providers/headers'
import { getDispatcher, isAbortError, isTimeoutError, sendToUpstream, drainBody, type UpstreamResponse } from '../proxy'
import { normalizeUpstreamPath } from '../proxy/path'
import { createUsageParser } from '../proxy/usage'
import {
  parseProxyBody,
  readRequestBody,
  releaseProxyBody,
  rewriteProxyBody,
  MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
} from '../proxy/body'
import { findRoute, listAliasNames, type RouteCandidate } from '../services/models'
import { buildCandidateOrder, parseRoutingConfig } from '../services/routing'
import { pickCandidate, reportSuccess, reportFailure, reportClientCancel } from '../services/health'
import { writeLog, updateLogResponseBytes, updateLogUsage } from '../services/logs'
import { getGlobalTimeoutMs } from '../services/settings'
import { assertSafeOutboundUrl, OutboundUrlError } from '../services/url-guard'
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

/** 这些上游状态视为「该候选的故障」，可在首字节写出前换下一候选重试；其余 4xx 属客户端问题，原样透传 */
const RETRYABLE_STATUS = new Set([401, 403, 408, 429])

function retryableStatusError(status: number): { code: string; clientStatus: number } {
  if (status === 429) return { code: 'upstream_rate_limited', clientStatus: 502 }
  if (status === 401 || status === 403) return { code: 'upstream_auth_error', clientStatus: 502 }
  if (status === 408) return { code: 'upstream_timeout', clientStatus: 504 }
  return { code: 'upstream_error', clientStatus: 502 }
}

/**
 * 统计转发给客户端的响应字节数，并被动解析 usage，在流正常结束时回填日志。
 * 用 TransformStream（而非 for-await + enqueue 的手写循环）以保证背压语义不被破坏。
 */
function countResponse(body: Readable, logId: number): ReadableStream<Uint8Array> {
  let total = 0
  const usage = createUsageParser()
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength
      usage.feed(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      updateLogResponseBytes(logId, total)
      updateLogUsage(logId, usage.snapshot() ?? { prompt_tokens: null, completion_tokens: null, total_tokens: null })
    },
  })
  return (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>).pipeThrough(counted)
}

interface AttemptOutcome {
  kind: 'done' | 'retryable'
  response?: Response
  /** 重试耗尽后对客户端的最终状态码与错误码 */
  clientStatus?: number
  code?: string
  message?: string
}

/** 把上游响应原样转给客户端（过滤逐跳头），并挂字节统计/usage 解析；保留 Retry-After 等头 */
function buildPassthroughResponse(res: UpstreamResponse, logId: number): Response {
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(k) || k === 'content-length') return
    headers[key] = value
  })
  if (!headers['content-type']) headers['content-type'] = 'application/json'
  return new Response(countResponse(res.body, logId) as unknown as BodyInit, { status: res.status, headers })
}

/**
 * 单次候选尝试：发请求、写该次 attempt 的日志行，返回透传响应或「可重试失败」标记。
 * 在首个字节写给客户端之前（即本函数返回 done 之前）失败都可以安全重试；
 * 一旦 done 的 Response 开始向客户端流动，调用方不得再切换候选。
 */
async function forwardAttempt(params: {
  c: Context
  provider: ProviderRow
  upstreamPath: string
  method: string
  outBody: Uint8Array
  startedAt: number
  protocol: 'openai' | 'anthropic'
  requestedModel: string
  resolvedModel: string
  requestBytes: number
  attempt: number
  /** single 模式（恒为单次尝试）：4xx 可重试状态直接透传原始响应（含 Retry-After），不包装成 502/504 */
  passthroughRetryable4xx?: boolean
}): Promise<AttemptOutcome> {
  const { c, provider, upstreamPath, method, outBody, startedAt, protocol, requestedModel, resolvedModel, requestBytes, attempt, passthroughRetryable4xx } = params
  const attemptStartedAt = Date.now()
  const queryString = c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : ''
  const url = buildUpstreamUrl(provider.base_url, upstreamPath, queryString)
  // 出站兜底校验（base_url 在 Provider 保存时已校验，这里防拼接后的最终 URL）
  assertSafeOutboundUrl(url)
  const timeoutMs = provider.timeout_ms ?? getGlobalTimeoutMs()
  const clientSignal = c.req.raw.signal

  let res
  try {
    res = await sendToUpstream({
      method,
      url,
      headers: buildUpstreamHeaders(provider, c.req.raw.headers),
      body: outBody,
      signal: clientSignal,
      dispatcher: getDispatcher(provider.proxy_url, timeoutMs),
    })
  } catch (err) {
    if (isAbortError(err) || clientSignal.aborted) throw err
    const timeout = isTimeoutError(err)
    const status = timeout ? 504 : 502
    const code = timeout ? 'upstream_timeout' : 'upstream_error'
    const message = timeout ? 'upstream timeout' : 'upstream request failed'
    writeLog({
      client_ip: clientIp(c),
      protocol,
      method,
      path: c.req.path,
      model: requestedModel,
      provider_id: provider.id,
      provider_name: provider.name,
      resolved_model: resolvedModel,
      status,
      latency_ms: Date.now() - attemptStartedAt,
      error_code: code,
      request_bytes: requestBytes,
      attempt,
    })
    return { kind: 'retryable', clientStatus: status, code, message }
  }

  // 收到上游响应头，立即写日志（latency = 该次尝试的首包耗时）
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
    latency_ms: headerAt - attemptStartedAt,
    error_code: res.status >= 400 && (RETRYABLE_STATUS.has(res.status) || res.status >= 500) ? retryableStatusError(res.status).code : null,
    request_bytes: requestBytes,
    attempt,
  })

  if (res.status >= 500 || RETRYABLE_STATUS.has(res.status)) {
    if (passthroughRetryable4xx && RETRYABLE_STATUS.has(res.status)) {
      return { kind: 'done', response: buildPassthroughResponse(res, logId) }
    }
    await drainBody(res.body)
    const { code, clientStatus } = retryableStatusError(res.status)
    return { kind: 'retryable', clientStatus, code, message: `upstream error (HTTP ${res.status})` }
  }

  return { kind: 'done', response: buildPassthroughResponse(res, logId) }
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
      if (protocol === 'anthropic') {
        // Anthropic Models API 形状：{data:[{id,type,display_name}], has_more, first_id, last_id}
        const data = aliases.map((name) => ({ id: name, type: 'model', display_name: name }))
        return c.json({
          data,
          has_more: false,
          first_id: aliases[0] ?? null,
          last_id: aliases.length > 0 ? aliases[aliases.length - 1]! : null,
        })
      }
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

    // 路由落地：按映射配置生成候选尝试顺序，由健康状态机逐个消费
    const config = parseRoutingConfig(route.alias.routing_config_json)
    const ordered = buildCandidateOrder(route.alias, route.candidates.map((candidate) => candidate.target))
    const aliasKey = `${protocol}/${model}`
    const maxAttempts = config.mode === 'single' ? 1 : Math.min(config.max_attempts ?? ordered.length, ordered.length)

    try {
      let lastFailure: { clientStatus: number; code: string; message: string } | null = null
      const attemptedTargetIds = new Set<number>()
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const remaining = ordered.filter((target) => !attemptedTargetIds.has(target.id))
        const pick = pickCandidate(aliasKey, remaining, config)
        if (!pick) {
          // 剩余候选全部冷却中且探测位被占用，或已无剩余候选：快速失败
          return logAndFail(c, protocol, path, 'POST', model, startedAt, 503, 'no_available_target', lastFailure ? lastFailure.message : 'no available route target')
        }
        attemptedTargetIds.add(pick.target.id)
        const candidate: RouteCandidate = route.candidates.find((item) => item.target.id === pick.target.id)!
        try {
          const outBody = rewriteProxyBody(parsed, candidate.model.model_id, route.thinking)
          const outcome = await forwardAttempt({
            c,
            provider: candidate.provider,
            upstreamPath,
            method: 'POST',
            outBody,
            startedAt,
            protocol,
            requestedModel: model,
            resolvedModel: candidate.model.model_id,
            requestBytes,
            attempt,
            passthroughRetryable4xx: config.mode === 'single',
          })
          if (outcome.kind === 'done') {
            // single 模式：保持 v8 行为，不参与健康状态机
            if (config.mode !== 'single') {
              reportSuccess(aliasKey, candidate.target.id, config, {
                // 探测成功或故障切换后的成功才进入亲和期，普通命中不亲和
                armAffinity: pick.isProbe || attempt > 1,
              })
            }
            return outcome.response!
          }
          lastFailure = { clientStatus: outcome.clientStatus!, code: outcome.code!, message: outcome.message! }
          // single 模式：保持 v8 行为，失败不进入冷却
          if (config.mode !== 'single') {
            reportFailure(aliasKey, candidate.target.id, config)
          }
        } catch (err) {
          // forwardAttempt 只会向外抛客户端取消；取消不是候选的失败，但需释放探测位
          if (isAbortError(err) || c.req.raw.signal.aborted) {
            if (pick.isProbe) reportClientCancel(aliasKey, candidate.target.id)
          }
          throw err
        }
      }
      // 所有候选尝试均失败（每 attempt 已写日志，不再补写）；single 模式的 4xx 已在最后一次尝试内透传
      return proxyError(c, lastFailure?.clientStatus ?? 502, lastFailure?.message ?? 'upstream error', lastFailure?.code ?? 'upstream_error')
    } finally {
      releaseProxyBody(parsed)
    }
  } catch (err) {
    if (isAbortError(err) || c.req.raw.signal.aborted) {
      throw err
    }
    if (err instanceof RequestBodyTooLargeError) {
      return logAndFail(c, protocol, path, c.req.method, requestedModel, startedAt, 413, 'invalid_request_body', 'request body too large (max 50MB)')
    }
    if (err instanceof OutboundUrlError) {
      return logAndFail(c, protocol, path, c.req.method, requestedModel, startedAt, 502, 'outbound_url_invalid', 'upstream base url is invalid')
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
      timeout ? 'upstream timeout' : 'upstream error',
    )
  }
})
