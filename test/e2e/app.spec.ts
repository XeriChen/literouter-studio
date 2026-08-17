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
