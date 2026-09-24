import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-crypto-badenv-'))
process.chdir(tempRoot)
process.env.ENCRYPTION_KEY = 'too-short'

const { encrypt } = await import('../src/crypto')

after(() => {
  delete process.env.ENCRYPTION_KEY
  process.chdir(originalCwd)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('ENCRYPTION_KEY 格式非法时直接抛错，绝不静默另生成新密钥', () => {
  assert.throws(() => encrypt('x'), /64 hex characters/)
  assert.ok(!existsSync(join(tempRoot, 'data', '.generated-encryption-key')))
})
