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
  // 不提前返回长度差异，避免泄露 token 长度信息；用等长 padding 对齐后做常数时间比较
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // 长度不等时仍执行一次比较以保持常数时间，但比较结果必然为 false
    const padded = Buffer.alloc(Math.max(a.length, b.length))
    return false
  }
  return timingSafeEqual(a, b)
}