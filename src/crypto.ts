import crypto from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32 // 256 bits

let encryptionKey: Buffer | null = null

function persistGeneratedKey(hexKey: string): string {
  const dataDir = join(process.cwd(), 'data')
  const keyPath = join(dataDir, '.generated-encryption-key')
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(keyPath, `${hexKey}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(keyPath, 0o600)
    } catch {
      // Windows 等平台可能无法完整落实 POSIX 权限，忽略
    }
  } catch (err) {
    console.warn(`Failed to write generated ENCRYPTION_KEY to ${keyPath}:`, err instanceof Error ? err.message : String(err))
    return keyPath
  }
  return keyPath
}

function getEncryptionKey(): Buffer {
  if (encryptionKey) return encryptionKey

  const envKey = process.env.ENCRYPTION_KEY
  if (envKey) {
    if (envKey.length === KEY_LENGTH * 2) {
      encryptionKey = Buffer.from(envKey, 'hex')
      return encryptionKey
    }
    console.warn(`ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex characters, generating new key`)
  }

  const newKey = crypto.randomBytes(KEY_LENGTH)
  const hexKey = newKey.toString('hex')
  const keyPath = persistGeneratedKey(hexKey)
  // 绝不向 stdout/stderr 打印密钥本体
  console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.warn('⚠️  已生成新的 ENCRYPTION_KEY，请立即写入项目根目录 .env，否则重启后已存凭据无法解密')
  console.warn(`   密钥已写入 ${keyPath}（权限 0600），取出写入 .env 后请删除该文件。`)
  console.warn('   Losing this key means all stored provider auth data will be')
  console.warn('   unrecoverable and must be re-entered.')
  console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  encryptionKey = newKey
  return encryptionKey
}

export function encrypt(text: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(encrypted: string): string {
  const key = getEncryptionKey()
  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new Error('invalid encrypted format')
  }
  const [ivHex, authTagHex, encryptedHex] = parts
  if (!ivHex || !authTagHex || (encryptedHex === undefined)) {
    throw new Error('invalid encrypted format: missing parts')
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  return decipher.update(encryptedHex || '', 'hex', 'utf8') + decipher.final('utf8')
}
