import type { MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { isAbortError } from '../proxy'
import type { Env } from '../types'

export const errorMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  try {
    await next()
  } catch (err) {
    // 客户端主动断连产生的 AbortError 不打日志、不返回 500（连接已关闭，返回也无意义）
    if (isAbortError(err) || c.req.raw.signal.aborted) {
      return
    }
    const status: ContentfulStatusCode = 500
    console.error('[gateway] unhandled error:', err)
    return c.json(
      {
        ok: false,
        error: { message: 'internal error', type: 'internal_error', code: 'internal_error' },
      },
      status,
    )
  }
}