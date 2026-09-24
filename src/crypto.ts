import crypto from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from './paths'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32 // 256 bits
const KEY_FILENAME = '.generated-encryption-key'

let encryptionKey: Buffer | null = null
let keySource: 'env' | 'file' | 'generated' | null = null

function getKeyPath(): string {
  return join(getDataDir(), KEY_FILENAME)
}

function persistGeneratedKey(hexKey: string): string {
  const dataDir = getDataDir()
  const keyPath = join(dataDir, KEY_FILENAME)
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
  }
  return keyPath
}

/**
 * 读回上次启动自动生成并持久化的密钥。
 * 文件不存在返回 null（首次启动）；文件存在但内容非法直接抛错（fail-closed），
 * 绝不忽略坏文件另生成一把新密钥，否则既有密文会被静默判为不可解密。
 */
function readPersistedKey(): Buffer | null {
  const keyPath = getKeyPath()
  if (!existsSync(keyPath)) return null
  const raw = readFileSync(keyPath, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(
      `persisted ENCRYPTION_KEY file is invalid (must be 64 hex characters): ${keyPath}. ` +
        'Set the correct ENCRYPTION_KEY in .env and restart.',
    )
  }
  return Buffer.from(raw, 'hex')
}

function getEncryptionKey(): Buffer {
  if (encryptionKey) return encryptionKey

  const envKey = process.env.ENCRYPTION_KEY
  if (envKey) {
    if (envKey.length !== KEY_LENGTH * 2) {
      // 显式配置却格式错误：直接失败，绝不静默另生成新密钥导致既有凭据错配
      throw new Error(`ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex characters, got ${envKey.length}`)
    }
    encryptionKey = Buffer.from(envKey, 'hex')
    keySource = 'env'
    return encryptionKey
  }

  // 重启复用：上次自动生成的密钥仍在数据目录，读回后既有密文可正常解密
  const persisted = readPersistedKey()
  if (persisted) {
    encryptionKey = persisted
    keySource = 'file'
    return encryptionKey
  }

  const newKey = crypto.randomBytes(KEY_LENGTH)
  const hexKey = newKey.toString('hex')
  const keyPath = persistGeneratedKey(hexKey)
  // 绝不向 stdout/stderr 打印密钥本体
  console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.warn('⚠️  未配置 ENCRYPTION_KEY，已生成随机密钥并写入数据目录，请尽快写入项目根目录 .env 统一管理')
  console.warn(`   密钥文件：${keyPath}（权限 0600）。后续重启会自动读回该文件，已存凭据仍可解密；`)
  console.warn('   确认 .env 生效后应删除该文件，避免随数据目录拷贝泄漏。')
  console.warn('   若 .env 与密钥文件同时缺失且数据库里已有加密凭据，网关将拒绝启动，')
  console.warn('   以防静默换钥导致凭据永久不可解密。')
  console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  encryptionKey = newKey
  keySource = 'generated'
  return encryptionKey
}

/** 本次进程实际使用的密钥来源（env=环境变量/.env，file=读回持久化文件，generated=现场新生成）。 */
export function getEncryptionKeySource(): 'env' | 'file' | 'generated' {
  if (!encryptionKey) getEncryptionKey()
  return keySource as 'env' | 'file' | 'generated'
}

/**
 * 启动护栏：数据库里已存在加密凭据时，本次密钥必须来自环境变量或既有持久化文件。
 * 若密钥只能现场新生成（.env 与密钥文件都缺失/不可用），旧密文将永久不可解密，
 * 直接抛错拒绝启动，要求先恢复原密钥。
 */
export function assertKeyReadyForStoredSecrets(hasEncryptedSecrets: boolean): void {
  if (!encryptionKey) getEncryptionKey()
  if (hasEncryptedSecrets && keySource === 'generated') {
    throw new Error(
      `[gateway] encrypted provider credentials exist, but neither ENCRYPTION_KEY nor ${KEY_FILENAME} in the data directory is available. ` +
        'Starting with a freshly generated key would permanently make the stored credentials undecryptable; refusing to start. ' +
        'Restore the original ENCRYPTION_KEY (in .env or the key file) and restart.',
    )
  }
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
