import { randomUUID, timingSafeEqual } from 'node:crypto'
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
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
