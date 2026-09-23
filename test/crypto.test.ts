import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-crypto-'))
process.chdir(tempRoot)
delete process.env.ENCRYPTION_KEY

const warnings: string[] = []
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
}

const { encrypt, decrypt } = await import('../src/crypto')
// 触发自动生成密钥
encrypt('boot')
console.warn = originalWarn

after(() => {
  process.chdir(originalCwd)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('generated ENCRYPTION_KEY is written to data/.generated-encryption-key and never printed', () => {
  const keyPath = join(tempRoot, 'data', '.generated-encryption-key')
  assert.ok(existsSync(keyPath), 'key file must be written')
  const key = readFileSync(keyPath, 'utf8').trim()
  assert.match(key, /^[0-9a-f]{64}$/)
  for (const w of warnings) {
    assert.ok(!w.includes(key), `warning must not contain the key: ${w}`)
    assert.ok(!/ENCRYPTION_KEY=[0-9a-f]{64}/.test(w), `warning must not print ENCRYPTION_KEY=...: ${w}`)
  }
  assert.ok(warnings.some((w) => w.includes('ENCRYPTION_KEY') && w.includes('.env')), 'must instruct user to persist key in .env')
})

test('encrypt and decrypt round trip', () => {
  const plaintext = 'sensitive API key'
  const encrypted = encrypt(plaintext)
  const decrypted = decrypt(encrypted)
  assert.strictEqual(decrypted, plaintext)
})

test('encrypted format contains three parts', () => {
  const encrypted = encrypt('test')
  const parts = encrypted.split(':')
  assert.strictEqual(parts.length, 3)
})

test('decrypt throws on invalid format', () => {
  assert.throws(() => decrypt('invalid'), /invalid encrypted format/)
  assert.throws(() => decrypt('only:two'), /invalid encrypted format/)
})

test('encrypt produces different ciphertext each time', () => {
  const plaintext = 'same input'
  const encrypted1 = encrypt(plaintext)
  const encrypted2 = encrypt(plaintext)
  assert.notStrictEqual(encrypted1, encrypted2)
  assert.strictEqual(decrypt(encrypted1), plaintext)
  assert.strictEqual(decrypt(encrypted2), plaintext)
})

test('handles empty string', () => {
  const encrypted = encrypt('')
  const parts = encrypted.split(':')
  assert.strictEqual(parts.length, 3)
  assert.ok(parts[0])
  assert.ok(parts[1])
  assert.strictEqual(parts[2], '')
  const decrypted = decrypt(encrypted)
  assert.strictEqual(decrypted, '')
})

test('handles unicode characters', () => {
  const plaintext = '你好世界 🔐 émojis'
  const encrypted = encrypt(plaintext)
  const decrypted = decrypt(encrypted)
  assert.strictEqual(decrypted, plaintext)
})

test('decrypt throws on tampered ciphertext', () => {
  const encrypted = encrypt('original')
  const parts = encrypted.split(':')
  const tampered = `${parts[0]}:${parts[1]}:ffffffff`
  assert.throws(() => decrypt(tampered))
})
