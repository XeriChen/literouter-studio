import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import nodeCrypto from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 模拟「重启」前提：上次启动生成的密钥文件已在数据目录（GATEWAY_DATA_DIR），
// 当前进程既无 ENCRYPTION_KEY，cwd 也指向另一个目录。
const originalCwd = process.cwd()
const cwdDir = mkdtempSync(join(tmpdir(), 'literouter-crypto-cwd-'))
const dataDir = mkdtempSync(join(tmpdir(), 'literouter-crypto-data-'))
process.chdir(cwdDir)
delete process.env.ENCRYPTION_KEY
process.env.GATEWAY_DATA_DIR = dataDir

const knownKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(dataDir, '.generated-encryption-key'), `${knownKey}\n`, 'utf8')

const cryptoMod = await import('../src/crypto')

after(() => {
  delete process.env.GATEWAY_DATA_DIR
  process.chdir(originalCwd)
  rmSync(cwdDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

test('重启时从 GATEWAY_DATA_DIR 读回持久化密钥，且不在 cwd/data 下落文件', () => {
  assert.equal(cryptoMod.getEncryptionKeySource(), 'file')
  assert.ok(existsSync(join(dataDir, '.generated-encryption-key')))
  assert.ok(!existsSync(join(cwdDir, 'data', '.generated-encryption-key')))
})

test('用读回的密钥可解开「上次启动」写下的密文（跨重启凭据连续可读）', () => {
  const encrypted = cryptoMod.encrypt('persisted secret')
  const [ivHex, tagHex, dataHex] = encrypted.split(':')
  assert.ok(ivHex && tagHex && dataHex)
  const decipher = nodeCrypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(knownKey, 'hex'),
    Buffer.from(ivHex, 'hex'),
  )
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const plaintext = decipher.update(dataHex, 'hex', 'utf8') + decipher.final('utf8')
  assert.equal(plaintext, 'persisted secret')
  assert.equal(cryptoMod.decrypt(encrypted), 'persisted secret')
})

test('密钥来自持久化文件时，启动护栏在已有加密凭据下放行', () => {
  assert.doesNotThrow(() => cryptoMod.assertKeyReadyForStoredSecrets(true))
})
