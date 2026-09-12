import { test } from 'node:test'
import assert from 'node:assert'
import { encrypt, decrypt } from '../src/crypto'

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
