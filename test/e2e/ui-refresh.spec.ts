import { expect, test, type Page } from '@playwright/test'
import type { ModelAlias } from '../../web/src/api/types'

const aliasName = "team/review ' & β"
const makeAlias = (protocol: 'openai' | 'anthropic', name = aliasName): ModelAlias => ({
  protocol, alias_name: name, group_id: null, group_name: null, enabled: 1,
  thinking_json: null, routing_config_json: null, provider_id: 'review-provider',
  model_id: 'real-model', provider_name: 'Review Provider', provider_protocol: protocol,
  provider_enabled: 1, target_enabled: 1, targets: [],
  created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
})

async function mockConsole(page: Page, aliases: ModelAlias[]) {
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'ui-review-fixture'))
  await page.route('**/api/**', (route) => route.fulfill({
    json: { ok: true, data: new URL(route.request().url()).pathname === '/api/aliases' ? aliases : [] },
  }))
}

test('command palette selects the exact protocol and alias and sends its streaming request', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  await mockConsole(page, [makeAlias('openai'), makeAlias('anthropic'), { ...makeAlias('openai', 'disabled-review'), enabled: 0 }])
  await page.goto('/')
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: '全局命令面板' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('option', { name: /disabled-review/ })).toHaveCount(0)
  // 同名映射属于独立协议空间，搜索后必须保持两个可分别选中的项目。
  await dialog.getByRole('combobox').fill(aliasName)
  await expect(dialog.getByRole('option')).toHaveCount(2)
  await dialog.getByRole('option', { name: /anthropic/ }).click()
  await expect(page.getByRole('button', { name: '一键提问：现在的美国总统是谁' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('protocol')).toBe('anthropic')
  expect(new URL(page.url()).searchParams.get('alias')).toBe(aliasName)
  await page.reload()
  await expect(page.getByRole('button', { name: '一键提问：现在的美国总统是谁' })).toBeVisible()

  let sentBody: { model?: string; messages?: Array<{ content: string }> } | undefined
  await page.route('**/anthropic/v1/messages', async (route) => {
    sentBody = route.request().postDataJSON()
    await route.fulfill({
      contentType: 'text/event-stream',
      body: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Review streamed reply"}}\n\n',
    })
  })
  await page.getByRole('button', { name: '一键提问：现在的美国总统是谁' }).click()
  await expect(page.getByText('Review streamed reply', { exact: true })).toBeVisible()
  expect(sentBody?.model).toBe(aliasName)
  expect(sentBody?.messages?.[0]?.content).toBe('现在的美国总统是谁')
  await expect(page.getByRole('button', { name: '复制消息内容' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await dialog.getByRole('combobox').fill(aliasName)
  await dialog.getByRole('option', { name: /openai/ }).click()
  await expect(page.getByRole('button', { name: '一键提问：现在的美国总统是谁' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('protocol')).toBe('openai')
  await expect(page.getByText('Review streamed reply', { exact: true })).toHaveCount(0)
  await page.goBack()
  await expect(page.getByText('Review streamed reply', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('mobile palette opens above navigation and reports clipboard failure before retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockConsole(page, [])
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined })
    document.execCommand = () => false
  })
  await page.goto('/')
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.getByRole('button', { name: '搜索或指令...' }).click()
  const dialog = page.getByRole('dialog', { name: '全局命令面板' })
  await expect(dialog.getByRole('combobox')).toBeFocused()
  await dialog.getByRole('option', { name: /复制 OpenAI/ }).click()
  await expect(dialog.getByText('复制失败，请重试', { exact: true })).toBeVisible()
  await expect(dialog.getByText('✓ 已复制完整 URL', { exact: true })).toHaveCount(0)
  await page.evaluate(() => { document.execCommand = () => true })
  await dialog.getByRole('option', { name: /复制失败/ }).click()
  await expect(dialog.getByText('✓ 已复制完整 URL', { exact: true })).toBeVisible()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toHaveCount(1)
  await page.keyboard.press('Control+k')
  await dialog.getByRole('option', { name: /切换主题/ }).click()
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light')
  await page.keyboard.press('Escape')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('dashboard cURL uses configured alias and copies exactly the displayed command', async ({ page }) => {
  await mockConsole(page, [makeAlias('openai')])
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => { localStorage.setItem('review-copied', text) } },
    })
  })
  await page.goto('/')
  const snippet = page.locator('pre code')
  await expect(snippet).toContainText('team/review')
  const displayed = await snippet.textContent()
  await page.getByRole('button', { name: '复制 cURL 命令' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('review-copied'))).toBe(displayed)
  expect(displayed).toContain('<GATEWAY_TOKEN>')
  expect(displayed).not.toContain('gpt-4o')
  expect(displayed).toContain("'\\''")
  await page.getByRole('button', { name: 'Anthropic', exact: true }).click()
  await expect(snippet).toContainText('<MODEL_ALIAS>')
  await expect(snippet).toContainText('"max_tokens": 1024')
  await page.getByRole('button', { name: '复制 cURL 命令' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('review-copied'))).toBe(await snippet.textContent())
})
