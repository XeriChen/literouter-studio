import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const originalCwd = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'literouter-crypto-badfile-'))
process.chdir(tempRoot)
delete process.env.ENCRYPTION_KEY

// 持久化密钥文件存在但内容损坏：必须 fail-closed，不能忽略坏文件另生成新密钥
const dataDir = join(tempRoot, 'data')
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(dataDir, '.generated-encryption-key'), 'not-a-valid-key\n', 'utf8')

const cryptoMod = await import('../src/crypto')

after(() => {
  process.chdir(originalCwd)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('持久化密钥文件内容非法时抛错，要求显式配置 ENCRYPTION_KEY', () => {
  assert.throws(() => cryptoMod.encrypt('x'), /persisted ENCRYPTION_KEY file is invalid/)
})
