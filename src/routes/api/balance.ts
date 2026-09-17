import { Hono } from 'hono'
import type { Env } from '../../types'
import { getProviderBalance, listBalanceSnapshots } from '../../services/balance'
import { writeAuditLog } from '../../services/audit'
import { UpstreamError, httpStatusForUpstreamError } from '../../services/errors'
import { redactText } from '../../services/redact'

const app = new Hono<Env>()

app.get('/:id/balance', async (c) => {
  const providerId = c.req.param('id')
  const force = c.req.query('force') === '1'

  try {
    const result = await getProviderBalance(providerId, { force })
    const used = result.unlimited ? result.balances.find((item) => item.label === '已用') : undefined
    const detail = result.unlimited
      ? `balance=unlimited${used ? `, used=${used.balance}` : ''}`
      : `balance=${result.balance}`
    writeAuditLog({
      resource: 'provider',
      target: providerId,
      action: 'balance',
      detail,
      status: 200,
    })
    return c.json({ ok: true, data: result })
  } catch (err) {
    const code = err instanceof UpstreamError ? err.code : 'upstream_error'
    const rawMessage = err instanceof Error ? err.message : 'unknown error'
    const message = redactText(rawMessage)
    const status = httpStatusForUpstreamError(code)

    writeAuditLog({
      resource: 'provider',
      target: providerId,
      action: 'balance',
      detail: redactText(`${code}: ${rawMessage}`),
      status,
    })

    return c.json({ ok: false, error: { message, type: code, code } }, status as 400 | 404 | 502 | 504)
  }
})

app.get('/:id/balance/snapshots', (c) => {
  const providerId = c.req.param('id')
  return c.json({ ok: true, data: listBalanceSnapshots(providerId) })
})

export default app
