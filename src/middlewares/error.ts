import type { MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env } from '../types'

export const errorMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  try {
    await next()
  } catch (err) {
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