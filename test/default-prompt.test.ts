import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 默认测活提示词的前后端一致性守卫。
 *
 * 前端只认得 `@/`（web/src）alias，无法直接 import 后端常量，`web/src/lib/prompts.ts`
 * 的 DEFAULT_PROMPT 只能手抄后端 src/routes/api/models.ts 的 DEFAULT_TEST_PROMPT。
 * 这里比对两侧源码字面量，任一侧漂移都会在 `pnpm test` 直接失败，
 * 避免「弹窗留空走后端默认、行内/Playground 用前端常量」出现两套提示词。
 */

const repoRoot = join(import.meta.dirname, '..')

function literal(file: string, name: string): string {
  const source = readFileSync(join(repoRoot, file), 'utf8')
  const matched = source.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`))
  assert.ok(matched, `${file} 中未找到 ${name} 字符串字面量`)
  return matched[1]
}

const backendPrompt = literal('src/routes/api/models.ts', 'DEFAULT_TEST_PROMPT')
const frontendPrompt = literal('web/src/lib/prompts.ts', 'DEFAULT_PROMPT')

test('前端 DEFAULT_PROMPT 与后端 DEFAULT_TEST_PROMPT 一致', () => {
  assert.equal(frontendPrompt, backendPrompt)
})

test('默认测活提示词满足黑名单与长度约束', () => {
  // 与服务端提示词黑名单（hi/hello/你好/测试/test/1）同源的兜底约束：
  // trim 后至少 4 字符，且不能落在黑名单里，否则客户提交空 prompt 会被判非法。
  const normalized = backendPrompt.trim().toLowerCase()
  const blacklist = new Set(['hi', 'hello', '你好', '测试', 'test', '1'])
  assert.ok(normalized.length >= 4, `默认提示词过短：${backendPrompt}`)
  assert.ok(!blacklist.has(normalized), `默认提示词命中黑名单：${backendPrompt}`)
})
