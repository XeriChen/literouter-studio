import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { Readable } from 'node:stream'
import { authMiddleware } from '../middlewares/auth'
import { buildUpstreamHeaders, buildUpstreamUrl, HOP_BY_HOP_HEADERS } from '../providers/headers'
import { getDispatcher, isAbortError, isSafeToRetryTransportError, isTimeoutError, sendToUpstream, drainBody, type UpstreamResponse } from '../proxy'
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
import { pickCandidate, reportSuccess, reportFailure, reportClientCancel, getHealthSnapshot } from '../services/health'
import { hasKeyPool, pickKey, reportKeyFailure, reportKeySuccess, releaseKeyProbe, retryAfterMs, nextKeyRetrySeconds } from '../services/key-pool'
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

/**
 * 上游状态码分类（收到响应头后）：
 * - Provider 故障（凭据/权限 401-403、模型或端点缺失 404、超时 408、限流 429、服务端 5xx）
 *   → 拦截错误体，换 Key/候选重试并按规冷却；
 * - 其余 4xx（400/413/422 等）视为客户端请求错误 → 同样拦截错误体，但按原始状态码返回客户端，
 *   不切 Key/候选、不冷却，避免一次畸形请求毒化整池 Key 或整条候选链。
 * 拦截（不透传上游错误体）对所有 4xx/5xx 生效；成功响应（<400）照常透传。
 */
function isProviderFaultStatus(status: number): boolean {
  if (status === 401 || status === 402 || status === 403) return true
  if (status === 404) return true
  if (status === 408 || status === 429) return true
  return status >= 500
}

/** Provider 故障状态码 → 候选耗尽后对客户端包装的状态码与错误码。 */
function retryableStatusError(status: number): { code: string; clientStatus: number } {
  if (status === 429) return { code: 'upstream_rate_limited', clientStatus: 502 }
  if (status === 401 || status === 402 || status === 403) return { code: 'upstream_auth_error', clientStatus: 502 }
  if (status === 404) return { code: 'upstream_not_found', clientStatus: 502 }
  if (status === 408) return { code: 'upstream_timeout', clientStatus: 504 }
  return { code: 'upstream_error', clientStatus: 502 }
}

/** 上游错误的日志 error_code：Provider 故障归入对应 upstream_* 码，客户端请求错误归为 upstream_request_error。 */
function upstreamErrorCode(status: number): string {
  return isProviderFaultStatus(status) ? retryableStatusError(status).code : 'upstream_request_error'
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
  kind: 'done' | 'retryable' | 'terminal'
  response?: Response
  /** 重试耗尽后对客户端的最终状态码与错误码 */
  clientStatus?: number
  code?: string
  message?: string
  upstreamStatus?: number | null
  retryHeaders?: Record<string, string>
  /** 结果可能已发送到当前 Provider；跳过该 Provider 的其他 Key，直接换候选。 */
  candidateOnly?: boolean
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
 * 单次候选尝试：发请求、写该次 attempt 的日志行，返回成功透传响应、「可重试失败」或「客户端错误」标记。
 * Provider 故障的 HTTP 错误允许换 Key/候选重试并按规冷却；客户端请求错误（其余 4xx）按原始状态码返回客户端，
 * 不重试、不冷却；响应头阶段结果不明的传输错误只允许切换真实模型 Provider，不在当前 Provider 内重放其他 Key。
 * 一旦 done 的 Response 开始流动也不得切换。
 */
async function forwardAttempt(params: {
  c: Context
  provider: ProviderRow
  upstreamPath: string
  method: string
  outBody: Uint8Array
  protocol: 'openai' | 'anthropic'
  requestedModel: string
  resolvedModel: string
  requestBytes: number
  attempt: number
  apiKey?: string
}): Promise<AttemptOutcome> {
  const { c, provider, upstreamPath, method, outBody, protocol, requestedModel, resolvedModel, requestBytes, attempt, apiKey } = params
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
      headers: buildUpstreamHeaders(provider, c.req.raw.headers, apiKey),
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
    return {
      kind: 'retryable',
      clientStatus: status,
      code,
      message,
      upstreamStatus: null,
      candidateOnly: !isSafeToRetryTransportError(err),
    }
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
    error_code: res.status >= 400 ? upstreamErrorCode(res.status) : null,
    request_bytes: requestBytes,
    attempt,
  })

  if (res.status >= 400) {
    // 所有 4xx/5xx 一律拦截错误体，不透传给客户端
    await drainBody(res.body)
    if (isProviderFaultStatus(res.status)) {
      // Provider 故障：换 Key/候选重试并按规冷却
      const { code, clientStatus } = retryableStatusError(res.status)
      return { kind: 'retryable', clientStatus, code, message: `upstream error (HTTP ${res.status})`, upstreamStatus: res.status, retryHeaders: Object.fromEntries(res.headers.entries()) }
    }
    // 客户端请求错误（400/413/422 等其余 4xx）：按原始状态码返回，不切 Key/候选、不冷却
    return { kind: 'terminal', clientStatus: res.status, code: 'upstream_request_error', message: `upstream request error (HTTP ${res.status})`, upstreamStatus: res.status }
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
      let lastFailure: { clientStatus: number; code: string; message: string; retryAfter?: string } | null = null
      const attemptedTargetIds = new Set<number>()
      let outboundAttempt = 0
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const remaining = ordered.filter((target) => !attemptedTargetIds.has(target.id))
        const pick = pickCandidate(aliasKey, remaining, config)
        if (!pick) {
          // 剩余候选全部冷却中且探测位被占用，或已无剩余候选：快速失败
          const earliest = getHealthSnapshot(aliasKey).cooldowns[0]?.until
          if (earliest) c.header('Retry-After', String(Math.max(1, Math.ceil((earliest - Date.now()) / 1000))))
          else if (lastFailure?.retryAfter) c.header('Retry-After', lastFailure.retryAfter)
          return logAndFail(c, protocol, path, 'POST', model, startedAt, 503, 'no_available_target', lastFailure ? lastFailure.message : 'no available route target')
        }
        attemptedTargetIds.add(pick.target.id)
        const candidate: RouteCandidate = route.candidates.find((item) => item.target.id === pick.target.id)!
        let activeKey: { id: string; isProbe: boolean } | null = null
        try {
          const outBody = rewriteProxyBody(parsed, candidate.model.model_id, route.thinking)
          const pool = hasKeyPool(candidate.provider)
          const excluded = new Set<string>()
          let failed = false
          let candidateOnlyFailure = false
          let candidateRetryAfterMs: number | undefined
          do {
            const keyPick = pool ? pickKey(candidate.provider, candidate.model.model_id, excluded) : null
            if (pool && !keyPick) break
            if (keyPick) {
              activeKey = { id: keyPick.credential.id, isProbe: keyPick.isProbe }
              excluded.add(keyPick.credential.id)
            }
            const outcome = await forwardAttempt({
              c,
              provider: candidate.provider,
              upstreamPath,
              method: 'POST',
              outBody,
              protocol,
              requestedModel: model,
              resolvedModel: candidate.model.model_id,
              requestBytes,
              attempt: ++outboundAttempt,
              apiKey: keyPick?.credential.key,
            })
            if (outcome.kind === 'done') {
              // done 只承载成功响应（<400）：上报 Key 成功并按其释放探测位
              if (keyPick) reportKeySuccess(candidate.provider.id, keyPick.credential.id, candidate.model.model_id)
              if (config.mode !== 'single') {
                reportSuccess(aliasKey, candidate.target.id, config, { armAffinity: pick.isProbe || attempt > 1 })
              } else if (pick.isProbe) {
                reportClientCancel(aliasKey, candidate.target.id)
              }
              return outcome.response!
            }
            if (outcome.kind === 'terminal') {
              // 客户端请求错误：不切 Key/候选、不冷却，仅释放探测位并按原始状态码返回
              if (keyPick?.isProbe) releaseKeyProbe(candidate.provider.id, keyPick.credential.id, candidate.model.model_id)
              if (pick.isProbe) reportClientCancel(aliasKey, candidate.target.id)
              return proxyError(c, outcome.clientStatus!, outcome.message!, outcome.code!)
            }
            failed = true
            lastFailure = { clientStatus: outcome.clientStatus!, code: outcome.code!, message: outcome.message!, retryAfter: outcome.retryHeaders?.['retry-after'] }
            candidateRetryAfterMs = outcome.retryHeaders ? retryAfterMs(outcome.retryHeaders) ?? undefined : undefined
            if (outcome.candidateOnly) {
              // 响应头阶段结果不明的传输错误：请求可能已被上游处理，不冷却 Key/候选，
              // 仅释放探测位后跳过当前 Provider，不在其内重放其他 Key
              if (keyPick?.isProbe) releaseKeyProbe(candidate.provider.id, keyPick.credential.id, candidate.model.model_id)
              if (pick.isProbe) reportClientCancel(aliasKey, candidate.target.id)
              activeKey = null
              candidateOnlyFailure = true
              break
            }
            // 可归因失败（Provider 故障或明确未发送的连接错误）：冷却当前 Key，换同 Provider 下一 Key 重试
            if (keyPick) reportKeyFailure(candidate.provider.id, keyPick.credential.id, candidate.model.model_id, outcome.upstreamStatus ?? null, config.cooldown_seconds ?? 60, outcome.retryHeaders)
            activeKey = null
          } while (pool)
          if (!failed) {
            const retrySeconds = pool ? nextKeyRetrySeconds(candidate.provider, candidate.model.model_id) : null
            lastFailure = { clientStatus: 503, code: 'no_available_key', message: 'no available provider key', retryAfter: retrySeconds ? String(retrySeconds) : undefined }
          }
          // 候选冷却：Key 池由 Key 各自状态控制（避免误伤池内其他可用 Key）；无 Key 池候选在可归因失败后冷却；
          // ambiguous 传输错误（candidateOnlyFailure）与 single 模式均不冷却候选
          if (config.mode !== 'single' && failed && !pool && !candidateOnlyFailure) reportFailure(aliasKey, candidate.target.id, config, Date.now(), candidateRetryAfterMs)
        } catch (err) {
          // 取消不计失败；任何未完成的尝试都必须释放探测位。
          if (pick.isProbe) reportClientCancel(aliasKey, candidate.target.id)
          if (activeKey?.isProbe) releaseKeyProbe(candidate.provider.id, activeKey.id, candidate.model.model_id)
          throw err
        }
      }
      // 所有候选尝试均失败（每 attempt 已写日志，不再补写）。
      if (lastFailure?.retryAfter) c.header('Retry-After', lastFailure.retryAfter)
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
