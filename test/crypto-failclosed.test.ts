import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 全新数据目录：无 ENCRYPTION_KEY，也无持久化密钥文件
const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-crypto-failclosed-'))
process.chdir(tempRoot)
delete process.env.ENCRYPTION_KEY

const { assertKeyReadyForStoredSecrets, getEncryptionKeySource } = await import('../src/crypto')

after(() => {
  process.chdir(originalCwd)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('全新库无加密凭据时允许启动，并现场生成持久化密钥', () => {
  assert.doesNotThrow(() => assertKeyReadyForStoredSecrets(false))
  assert.equal(getEncryptionKeySource(), 'generated')
  assert.ok(existsSync(join(tempRoot, 'data', '.generated-encryption-key')))
})

test('已有加密凭据却只能现场生成新密钥时拒绝启动（fail-closed）', () => {
  assert.throws(
    () => assertKeyReadyForStoredSecrets(true),
    /encrypted provider credentials exist|refusing to start/,
  )
})
