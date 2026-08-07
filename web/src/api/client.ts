const TOKEN_KEY = 'llm_gateway_token'

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY)
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY)

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    clearToken()
    window.location.href = '/login'
    throw new Error('unauthorized')
  }

  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  return body as T
}

/** 直接调用网关代理入口（带网关 Token），返回原始响应体 */
export function proxyStream(path: string, body: Record<string, unknown>): Promise<Response> {
  const token = getToken()
  return fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}