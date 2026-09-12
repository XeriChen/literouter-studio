import { Hono } from 'hono'
import type { Env } from '../../types'
import { fetchNewApiBalance } from '../../services/balance'
import { writeAuditLog } from '../../services/audit'

const app = new Hono<Env>()

app.get('/:id/balance', async (c) => {
  const providerId = c.req.param('id')

  try {
    const result = await fetchNewApiBalance(providerId)

    writeAuditLog({
      resource: 'provider',
      target: providerId,
      action: 'balance',
      detail: `balance=${result.balance}`,
      status: 200,
    })

    return c.json({ ok: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'

    writeAuditLog({
      resource: 'provider',
      target: providerId,
      action: 'balance',
      detail: message,
      status: 500,
    })

    if (message.includes('not found')) {
      return c.json(
        {
          ok: false,
          error: {
            message: 'Provider not found',
            type: 'provider_not_found',
            code: 'provider_not_found',
          },
        },
        404,
      )
    }

    if (message.includes('not a New API instance')) {
      return c.json(
        {
          ok: false,
          error: {
            message: 'Provider is not a New API instance',
            type: 'invalid_upstream_type',
            code: 'invalid_upstream_type',
          },
        },
        400,
      )
    }

    if (message.includes('timed out')) {
      return c.json(
        {
          ok: false,
          error: {
            message: 'Balance query request timed out',
            type: 'upstream_timeout',
            code: 'upstream_timeout',
          },
        },
        504,
      )
    }

    return c.json(
      {
        ok: false,
        error: {
          message: 'Failed to query balance from upstream',
          type: 'upstream_error',
          code: 'upstream_error',
        },
      },
      502,
    )
  }
})

export default app
