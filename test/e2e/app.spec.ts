import { expect, test } from '@playwright/test'

test('loads the login page without browser errors', async ({ page }, testInfo) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))

  const response = await page.goto('/')

  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page).toHaveTitle('LLM Gateway')
  await expect(page.getByRole('heading', { name: /进入你的/ })).toBeVisible()
  await expect(page.getByPlaceholder('输入 gateway token')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('login-page.png'), fullPage: true })
  expect(browserErrors).toEqual([])
})

test('shows an actionable error for an invalid token', async ({ page }) => {
  await page.goto('/login')
  await page.getByPlaceholder('输入 gateway token').fill('invalid-token')
  await page.getByRole('button', { name: /进入工作台/ }).click()

  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByText('invalid token')).toBeVisible()
})

test('authenticates and renders the dashboard', async ({ page }) => {
  test.skip(!process.env.E2E_GATEWAY_TOKEN, 'set E2E_GATEWAY_TOKEN to run the authenticated smoke test')

  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))

  await page.goto('/login')
  await page.getByPlaceholder('输入 gateway token').fill(process.env.E2E_GATEWAY_TOKEN!)
  await page.getByRole('button', { name: /进入工作台/ }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: /每一次请求/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Providers' })).toBeVisible()
  expect(browserErrors).toEqual([])
})

test('renders grouped aliases and candidate controls', async ({ page }) => {
  test.skip(!process.env.E2E_GATEWAY_TOKEN, 'set E2E_GATEWAY_TOKEN to run the authenticated smoke test')

  await page.goto('/login')
  await page.getByPlaceholder('输入 gateway token').fill(process.env.E2E_GATEWAY_TOKEN!)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await page.goto('/models')

  await expect(page.getByRole('heading', { name: '模型映射' })).toBeVisible()
  await expect(page.getByRole('button', { name: /新建分组/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /新建映射/ })).toBeVisible()
  await expect(page.getByText('未分组').first()).toBeVisible()
  await expect(page.getByRole('columnheader', { name: '候选' }).first()).toBeVisible()
})

test('renders provider groups and supports copy and API Key visibility', async ({ page }, testInfo) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  await page.route('**/api/provider-groups', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: [{
          protocol: 'openai',
          id: 'group-production',
          name: 'Production',
          created_at: '2026-08-17T00:00:00.000Z',
          updated_at: '2026-08-17T00:00:00.000Z',
          provider_count: 1,
          enabled_count: 1,
        }],
      }),
    })
  })
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: [{
          id: 'provider-primary',
          name: 'Primary',
          protocol: 'openai',
          group_id: 'group-production',
          base_url: 'https://api.example.test',
          auth: { api_key: 'secret-key' },
          custom_headers: { 'x-test': 'enabled' },
          proxy_url: 'http://127.0.0.1:7890',
          timeout_ms: 120000,
          model_filter: 'gpt-*',
          enabled: 1,
          created_at: '2026-08-17T00:00:00.000Z',
          updated_at: '2026-08-17T00:00:00.000Z',
        }],
      }),
    })
  })

  await page.goto('/providers')
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible()
  await expect(page.getByText('Production').first()).toBeVisible()
  await expect(page.getByTitle('启用组内全部 Provider')).toBeVisible()
  await expect(page.getByTitle('删除组内全部 Provider')).toBeVisible()

  await page.getByRole('button', { name: '复制 Primary' }).click()
  const copyDialog = page.getByRole('dialog')
  await expect(copyDialog.getByRole('heading', { name: '复制 Provider' })).toBeVisible()
  await expect(copyDialog.locator('input').first()).toHaveValue('Primary 副本')
  const copyKey = copyDialog.getByRole('textbox', { name: 'API Key', exact: true })
  await expect(copyKey).toHaveAttribute('type', 'password')
  await expect(copyKey).toHaveValue('secret-key')
  await copyDialog.getByRole('button', { name: '显示 API Key' }).click()
  await expect(copyKey).toHaveAttribute('type', 'text')
  await page.screenshot({ path: testInfo.outputPath('provider-copy-dialog.png'), fullPage: true })
  await copyDialog.getByRole('button', { name: '取消' }).click()

  await page.getByRole('button', { name: '编辑 Primary' }).click()
  const editDialog = page.getByRole('dialog')
  await expect(editDialog.getByRole('heading', { name: '编辑 Provider' })).toBeVisible()
  await expect(editDialog.getByRole('combobox').first()).toBeDisabled()
  const editKey = editDialog.getByRole('textbox', { name: 'API Key', exact: true })
  await expect(editKey).toHaveAttribute('type', 'password')
  await editDialog.getByRole('button', { name: '显示 API Key' }).click()
  await expect(editKey).toHaveAttribute('type', 'text')
  await editDialog.getByRole('button', { name: '取消' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByText('Production').first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('provider-groups-mobile.png'), fullPage: true })
  expect(browserErrors).toEqual([])
})
