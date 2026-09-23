import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { getSetting, setSetting } from '../db'

const TOKEN_KEY = 'admin_token'

export function getAdminToken(): string {
  let token = getSetting(TOKEN_KEY)
  if (!token) {
    token = randomUUID()
    setSetting(TOKEN_KEY, token)
  }
  return token
}

export function resetAdminToken(): string {
  const token = randomUUID()
  setSetting(TOKEN_KEY, token)
  return token
}

export function setAdminToken(token: string): void {
  setSetting(TOKEN_KEY, token)
}

export function verifyToken(token: string | null | undefined): boolean {
  if (!token) return false
  const expected = getAdminToken()
  // 固定长度摘要后再比，避免直接比较 Buffer 长度泄露 token 长度
  const a = createHash('sha256').update(token, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}
