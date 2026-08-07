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
  if (token.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
}