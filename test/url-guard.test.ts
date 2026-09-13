import { test } from 'node:test'
import assert from 'node:assert'
import { assertSafeOutboundUrl, OutboundUrlError } from '../src/services/url-guard'

function expectBlocked(raw: string, reason?: string): void {
  assert.throws(() => assertSafeOutboundUrl(raw), OutboundUrlError, reason ?? `should block: ${raw}`)
}

test('accepts well-formed http(s) urls', () => {
  assert.ok(assertSafeOutboundUrl('http://127.0.0.1:3000/v1/chat/completions'))
  assert.ok(assertSafeOutboundUrl('https://api.example.com/api/user/self?key=1'))
  // 局域网/localhost 上游是核心场景，必须放行（红线 3）
  assert.ok(assertSafeOutboundUrl('http://192.168.1.10:8080/'))
})

test('blocks non-http schemes', () => {
  expectBlocked('file:///etc/passwd')
  expectBlocked('unix:/run/a.sock')
  expectBlocked('ftp://example.com/x')
  expectBlocked('javascript:alert(1)')
})

test('blocks malformed urls', () => {
  expectBlocked('')
  expectBlocked('not a url')
  expectBlocked('http://')
})

test('blocks embedded credentials', () => {
  expectBlocked('https://user:pass@example.com/api')
  expectBlocked('http://admin@127.0.0.1/')
})

test('blocks control characters and whitespace in host', () => {
  expectBlocked('http://exa\u0000mple.com/')
  expectBlocked('http://exa mple.com/')
  // 注：\n/\t 与路径中的控制字符会被 WHATWG URL 解析器剥除或百分号编码（结果本身安全），不在此列
})
