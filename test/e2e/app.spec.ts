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

test('renders provider groups and supports provider bulk actions', async ({ page }, testInfo) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  const groups = [{
    protocol: 'openai',
    id: 'group-production',
    name: 'Production',
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
    provider_count: 1,
    enabled_count: 1,
  }, {
    protocol: 'openai',
    id: 'group-staging',
    name: 'Staging',
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
    provider_count: 0,
    enabled_count: 0,
  }]
  let groupToggleEnabled: number | undefined
  let movedGroupId: string | null | undefined
  await page.route('**/api/provider-groups', async (route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { protocol: 'openai' | 'anthropic'; name: string }
      const created = { ...body, id: 'group-canary', created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z', provider_count: 0, enabled_count: 0 }
      groups.push(created)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: created }) })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: groups }),
    })
  })
  await page.route('**/api/provider-groups/batch-toggle', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { enabled?: number }
    groupToggleEnabled = body.enabled
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { updated: 1 } }) })
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
  await page.route('**/api/providers/provider-primary', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { group_id?: string | null }
      movedGroupId = body.group_id
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { id: 'provider-primary' } }) })
      return
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'not found', code: 'not_found', type: 'not_found' } }) })
  })

  await page.goto('/providers')
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible()
  await expect(page.getByText('Production').first()).toBeVisible()
  const groupSwitch = page.getByRole('switch', { name: '切换 Production 内全部 Provider 启用状态' })
  await expect(groupSwitch).toBeVisible()
  await groupSwitch.click()
  await expect.poll(() => groupToggleEnabled).toBe(0)
  await expect(page.getByTitle('删除组内全部 Provider').first()).toBeVisible()

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

  await page.getByRole('button', { name: '新增 Provider' }).click()
  const mobileDialog = page.getByRole('dialog')
  const formRegion = mobileDialog.getByRole('region', { name: 'Provider 配置' })
  await expect(mobileDialog.getByRole('heading', { name: '新增 Provider' })).toBeVisible()
  await expect(mobileDialog.getByRole('button', { name: '创建', exact: true })).toBeVisible()

  const dialogBox = await mobileDialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(844)

  const scrollMetrics = await formRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight)
  await formRegion.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(mobileDialog.getByText(/逗号分隔的前缀匹配规则/)).toBeVisible()
  await expect(mobileDialog.getByRole('button', { name: '创建', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('provider-create-dialog-mobile.png') })
  await formRegion.evaluate((element) => element.scrollTo({ top: 0 }))
  await mobileDialog.getByRole('button', { name: '新建 Provider 分组' }).click()
  const inlineGroupDialog = page.getByRole('dialog').last()
  await expect(inlineGroupDialog.getByRole('heading', { name: '新建 Provider 分组' })).toBeVisible()
  await inlineGroupDialog.getByRole('textbox').fill('Canary')
  await inlineGroupDialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(mobileDialog.getByRole('combobox').nth(1)).toContainText('Canary')
  await mobileDialog.getByRole('button', { name: '取消' }).click()

  await page.getByRole('button', { name: '切换 Production 多选模式' }).click()
  await page.getByRole('checkbox', { name: '选择 Primary' }).check()
  await expect(page.getByText('已选 1 个 Provider')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('provider-bulk-actions-mobile.png') })
  const moveSelect = page.getByRole('combobox', { name: '批量移动 Provider 到分组' })
  await moveSelect.click()
  await page.getByRole('option', { name: 'Staging' }).click()
  await expect.poll(() => movedGroupId).toBe('group-staging')
  await expect(page.getByText('批量移动分组完成')).toBeVisible()
  expect(browserErrors).toEqual([])
})

test('shows base64 decode feedback above the provider editor overlay', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  await page.route('**/api/provider-groups', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) })
  })
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) })
  })

  await page.goto('/providers')
  await page.getByRole('button', { name: '新增 Provider' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '新增 Provider' })).toBeVisible()

  const apiKey = dialog.getByRole('textbox', { name: 'API Key', exact: true })
  await dialog.getByRole('button', { name: '显示 API Key' }).click()
  await apiKey.fill('not-valid-base64!!!')
  await dialog.getByRole('button', { name: '解码' }).click()

  const decodeNotice = page.getByRole('status').filter({ hasText: '输入内容不是合法的 Base64' })
  await expect(decodeNotice).toBeVisible()
  const noticeBox = await decodeNotice.boundingBox()
  expect(noticeBox).not.toBeNull()
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return el?.closest('.notice')?.textContent ?? el?.textContent ?? ''
  }, { x: noticeBox!.x + noticeBox!.width / 2, y: noticeBox!.y + noticeBox!.height / 2 })
  expect(hit).toContain('输入内容不是合法的 Base64')

  await apiKey.fill('c2stdGVzdA==')
  await dialog.getByRole('button', { name: '解码' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已解码为明文并回填' })).toBeVisible()
  await expect(apiKey).toHaveValue('sk-test')
  await page.screenshot({ path: testInfo.outputPath('provider-decode-notice.png') })
})

test('aligns models table headers with row content', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  await page.route('**/api/alias-groups', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: [{ protocol: 'openai', id: 'g1', name: 'Production', created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z', alias_count: 1, enabled_count: 1 }],
      }),
    })
  })
  await page.route('**/api/aliases', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: [{
          protocol: 'openai',
          alias_name: 'my-brain',
          group_id: 'g1',
          enabled: 1,
          provider_id: 'p1',
          model_id: 'gpt-4',
          provider_name: 'Primary',
          provider_enabled: 1,
          target_enabled: 1,
          created_at: '2026-08-17T00:00:00.000Z',
          updated_at: '2026-08-17T00:00:00.000Z',
          targets: [{ id: 1, protocol: 'openai', alias_name: 'my-brain', provider_id: 'p1', model_id: 'gpt-4', provider_name: 'Primary', provider_enabled: 1, target_enabled: 1, priority: 0, active: 1, created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z' }],
        }],
      }),
    })
  })
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: [{ id: 'p1', name: 'Primary', protocol: 'openai', group_id: null, base_url: 'https://api.example.test', auth: {}, custom_headers: {}, enabled: 1, created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z' }],
      }),
    })
  })
  await page.route('**/api/models', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: [{ provider_id: 'p1', model_id: 'gpt-4', display_name: null, enabled: 1, source: 'manual', protocol: 'openai', provider_name: 'Primary', provider_enabled: 1, created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z' }],
      }),
    })
  })

  await page.goto('/models')
  await expect(page.getByRole('heading', { name: '模型映射' })).toBeVisible()
  await expect(page.getByText('my-brain')).toBeVisible()
  await expect(page.getByRole('button', { name: '启用全部' })).toHaveCount(0)

  async function assertTableColumnsAlign(table: ReturnType<typeof page.locator>) {
    const headerXs = await table.locator('thead th').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x))
    const cellXs = await table.locator('tbody tr').first().locator('> td').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x))
    expect(cellXs.length).toBe(headerXs.length)
    expect(headerXs.length).toBeGreaterThan(0)
    for (let index = 0; index < headerXs.length; index++) {
      expect(Math.abs((headerXs[index] ?? 0) - (cellXs[index] ?? 0))).toBeLessThan(2)
    }
  }

  const aliasTable = page.locator('table').first()
  await expect(aliasTable.getByRole('columnheader', { name: '映射名' })).toBeVisible()
  await assertTableColumnsAlign(aliasTable)
  await page.screenshot({ path: testInfo.outputPath('models-alias-columns.png') })

  await page.getByRole('button', { name: '真实模型' }).click()
  const realTable = page.locator('table').first()
  await expect(realTable.getByRole('columnheader', { name: 'Provider' })).toBeVisible()
  await assertTableColumnsAlign(realTable)
  await page.screenshot({ path: testInfo.outputPath('models-real-columns.png') })
})
