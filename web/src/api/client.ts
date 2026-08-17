const TOKEN_KEY = 'llm_gateway_token'

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY)
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY)

/**
 * 调用管理 API，自动解包 { ok: true, data: T } → T。
 * 401 自动清 token 跳转登录；非 2xx 抛 Error。
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(path, { ...init, headers })
  if (res.status === 401 && path !== '/api/login') {
    clearToken()
    window.location.href = '/login'
    throw new Error('unauthorized')
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { message?: string } } | null
  if (!res.ok || body?.ok !== true) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  return body.data as T
}

/** 构建带网关 Token 的请求头（供 ChatUI 等直接调用代理入口的组件使用） */
export function authHeaders(): Record<string, string> {
  const token = getToken()
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}
