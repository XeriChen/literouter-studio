import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32 // 256 bits

let encryptionKey: Buffer | null = null

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
  console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.warn('⚠️  No valid ENCRYPTION_KEY found. Generated a new one:')
  console.warn('')
  console.warn(`    ENCRYPTION_KEY=${hexKey}`)
  console.warn('')
  console.warn('   Save this to your .env file to persist provider credentials.')
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
