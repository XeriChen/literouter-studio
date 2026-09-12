import { getProvider } from './providers'
import { getDispatcher } from '../proxy'
import { request } from 'undici'

export interface BalanceResult {
  balance: number
  currency: string
  last_checked: string
}

interface NewApiUserResponse {
  quota?: number
}

interface Sub2ApiUserResponse {
  balance?: number
}

export async function fetchNewApiBalance(providerId: string): Promise<BalanceResult> {
  const provider = getProvider(providerId)
  if (!provider) {
    throw new Error('Provider not found')
  }

  if (provider.upstream_type !== 'newapi' && provider.upstream_type !== 'sub2api') {
    throw new Error('Provider is not a New API or Sub2API instance')
  }

  const baseUrl = provider.base_url.replace(/\/+$/, '')
  const url = provider.upstream_type === 'newapi'
    ? `${baseUrl}/api/user/self`
    : `${baseUrl}/api/v1/users/profile`

  const auth = JSON.parse(provider.auth_json)
  const headers: Record<string, string> = {
    'accept': 'application/json',
  }

  if (auth.api_key) {
    headers['authorization'] = `Bearer ${auth.api_key}`
  } else if (auth.access_token) {
    headers['authorization'] = `Bearer ${auth.access_token}`
  }

  const timeout = provider.timeout_ms || 30000
  const dispatcher = getDispatcher(provider.proxy_url, timeout)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  try {
    const response = await request(url, {
      method: 'GET',
      headers,
      dispatcher,
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (response.statusCode !== 200) {
      await response.body.dump()
      throw new Error(`Upstream returned ${response.statusCode}`)
    }

    let balanceUsd: number

    if (provider.upstream_type === 'newapi') {
      const data = (await response.body.json()) as NewApiUserResponse
      const quota = data.quota ?? 0
      balanceUsd = quota / 500000
    } else {
      const data = (await response.body.json()) as Sub2ApiUserResponse
      balanceUsd = data.balance ?? 0
    }

    return {
      balance: balanceUsd,
      currency: 'USD',
      last_checked: new Date().toISOString(),
    }
  } catch (err) {
    clearTimeout(timeoutId)

    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Balance query request timed out')
    }

    throw new Error(`Failed to fetch balance: ${err instanceof Error ? err.message : 'Unknown error'}`)
  }
}
