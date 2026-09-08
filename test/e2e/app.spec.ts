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
  // 分组默认折叠，展开后才渲染映射表格
  await page.locator('section button[aria-expanded]').first().click()
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

test('import dialog marks imported models and supports cancel and cleanup', async ({ page }, testInfo) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  // window.confirm 自动接受
  page.on('dialog', (dialog) => dialog.accept())

  const createdAt = '2026-08-17T00:00:00.000Z'
  const mockRow = (modelId: string, source: 'fetched' | 'manual') => ({
    provider_id: 'provider-primary',
    model_id: modelId,
    display_name: null,
    enabled: 1,
    source,
    fetched_at: source === 'fetched' ? createdAt : null,
    created_at: createdAt,
    updated_at: createdAt,
    provider_name: 'Primary',
    protocol: 'openai' as const,
    provider_enabled: 1,
  })
  let models = [mockRow('gpt-4o', 'fetched'), mockRow('gpt-4o-mini', 'fetched'), mockRow('manual-only', 'manual')]
  const deletedModels: Array<{ provider_id: string; model_id: string }> = []
  let cleanupCalls = 0
  let importedBody: unknown = null

  await page.route('**/api/provider-groups', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }))
  await page.route('**/api/providers', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, data: [{ id: 'provider-primary', name: 'Primary', protocol: 'openai', group_id: null, base_url: 'https://api.example.test', auth: { api_key: 'k' }, custom_headers: {}, proxy_url: null, timeout_ms: null, model_filter: null, enabled: 1, created_at: createdAt, updated_at: createdAt }] }),
  }))
  await page.route('**/api/providers/provider-primary/upstream-models', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, data: { model_ids: ['gpt-4o', 'gpt-4o-mini', 'manual-only'] } }),
  }))
  await page.route('**/api/providers/provider-primary/cleanup-imported-models', (route) => {
    cleanupCalls++
    models = models.filter((item) => item.source !== 'fetched')
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { deleted: 1 } }) })
  })
  await page.route('**/api/providers/provider-primary/import-models', (route) => {
    importedBody = JSON.parse(route.request().postData() ?? '{}')
    models = [...models, mockRow('gpt-4o-mini', 'fetched')]
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { added: 1, updated: 0 } }) })
  })
  await page.route('**/api/models', (route) => {
    if (route.request().method() === 'DELETE') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { provider_id?: string; model_id?: string }
      deletedModels.push({ provider_id: body.provider_id ?? '', model_id: body.model_id ?? '' })
      models = models.filter((item) => !(item.provider_id === body.provider_id && item.model_id === body.model_id))
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) })
      return
    }
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: models }) })
  })

  await page.goto('/providers')
  await page.getByRole('button', { name: '拉取 Primary 的模型' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '选择要导入的模型' })).toBeVisible()

  // 已入库状态标记：fetched → 已导入，manual → 已添加
  await expect(dialog.getByText('已导入', { exact: true })).toHaveCount(2)
  await expect(dialog.getByText('已添加', { exact: true })).toHaveCount(1)
  await expect(dialog.getByText(/已导入 2 个/)).toBeVisible()
  await dialog.getByRole('button', { name: /一键清理已导入（2）/ }).waitFor()
  await page.screenshot({ path: testInfo.outputPath('import-dialog-markers.png') })

  // 单个取消导入：确认后 DELETE /api/models，并移除该模型的选择
  await dialog.getByRole('button', { name: '取消导入 gpt-4o', exact: true }).click()
  await expect.poll(() => deletedModels).toEqual([{ provider_id: 'provider-primary', model_id: 'gpt-4o' }])
  await expect(dialog.getByText('已导入', { exact: true })).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: /一键清理已导入（1）/ })).toBeVisible()

  // 一键清理全部导入模型：只删 fetched，manual 保留
  await dialog.getByRole('button', { name: /一键清理已导入/ }).click()
  await expect.poll(() => cleanupCalls).toBe(1)
  await expect(dialog.getByText('已导入', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('已添加', { exact: true })).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: /一键清理已导入/ })).toHaveCount(0)

  // 清理后可重新导入同一模型
  await dialog.getByRole('checkbox', { name: '选择 gpt-4o-mini' }).check()
  await dialog.getByRole('button', { name: '导入 1 个模型' }).click()
  await expect(page.getByText('导入成功：新增 1，刷新 0')).toBeVisible()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(importedBody).toEqual({ model_ids: ['gpt-4o-mini'], create_alias: true })
  expect(browserErrors).toEqual([])
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
  // 分组默认折叠，先展开第一个分组
  await page.locator('section button[aria-expanded]').first().click()
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
  // 真实模型按 Provider 分组且默认折叠
  await page.locator('section[aria-label="真实模型分组"] button[aria-expanded]').first().click()
  const realTable = page.locator('section[aria-label="真实模型分组"] table').first()
  await expect(realTable.getByRole('columnheader', { name: 'Model' })).toBeVisible()
  await assertTableColumnsAlign(realTable)
  await page.screenshot({ path: testInfo.outputPath('models-real-columns.png') })
})

test('merges selected aliases into a new alias from the bulk bar', async ({ page }) => {
  const ts = '2026-09-06T00:00:00.000Z'
  const target = (id: number, aliasName: string, modelId: string, active: number) => ({
    id,
    protocol: 'openai',
    alias_name: aliasName,
    provider_id: 'p1',
    model_id: modelId,
    priority: 0,
    active,
    created_at: ts,
    updated_at: ts,
    provider_name: 'Primary',
    provider_protocol: 'openai',
    provider_enabled: 1,
    target_enabled: 1,
  })
  const aliases = [
    { protocol: 'openai', alias_name: 'alias-a', group_id: null, group_name: null, enabled: 1, thinking_json: null, provider_id: 'p1', model_id: 'mm-a', created_at: ts, updated_at: ts, provider_name: 'Primary', provider_protocol: 'openai', provider_enabled: 1, target_enabled: 1, targets: [target(1, 'alias-a', 'mm-a', 1)] },
    { protocol: 'openai', alias_name: 'alias-b', group_id: null, group_name: null, enabled: 1, thinking_json: null, provider_id: 'p1', model_id: 'mm-b', created_at: ts, updated_at: ts, provider_name: 'Primary', provider_protocol: 'openai', provider_enabled: 1, target_enabled: 1, targets: [target(2, 'alias-b', 'mm-b', 1)] },
  ]
  let mergeBody: Record<string, unknown> | null = null
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  await page.route('**/api/alias-groups', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }))
  await page.route('**/api/providers', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }))
  await page.route('**/api/models', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }))
  await page.route('**/api/aliases/merge', async (route) => {
    mergeBody = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { alias: { alias_name: 'merged-e2e', group_id: null }, created: true, added: 2, skipped: 0, deleted: 0 } }),
    })
  })
  await page.route('**/api/aliases', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: aliases }) }))

  await page.goto('/models')
  await expect(page.getByRole('heading', { name: '模型映射' })).toBeVisible()
  // 分组默认折叠，先展开
  await page.locator('section button[aria-expanded]').first().click()
  await expect(page.getByText('alias-a')).toBeVisible()

  await page.locator('section').first().getByLabel('切换 未分组 多选模式').click()
  await page.getByLabel('选择 alias-a').check()
  await page.getByLabel('选择 alias-b').check()

  await page.getByRole('button', { name: '合并' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('来源映射（2 个）')).toBeVisible()
  await expect(dialog.getByText('alias-a · 提供当前目标')).toBeVisible()
  await dialog.getByPlaceholder('merged-brain').fill('merged-e2e')
  // 默认不勾选「合并后删除原有映射」
  await expect(dialog.getByRole('checkbox', { name: /合并后删除原有映射/ })).not.toBeChecked()
  await dialog.getByRole('button', { name: '合并' }).click()

  await expect.poll(() => mergeBody).toMatchObject({
    protocol: 'openai',
    sources: ['alias-a', 'alias-b'],
    target_alias_name: 'merged-e2e',
    delete_sources: false,
  })
  await expect(page.getByText(/合并完成（新建映射）.*新增 2 个候选/)).toBeVisible()
})

test('imports aliases into a group and cleans up invalid aliases', async ({ page }) => {
  const ts = '2026-09-06T00:00:00.000Z'
  const target = (id: number, aliasName: string) => ({
    id,
    protocol: 'openai',
    alias_name: aliasName,
    provider_id: 'p1',
    model_id: 'mm-x',
    priority: 0,
    active: 1,
    created_at: ts,
    updated_at: ts,
    provider_name: 'Primary',
    provider_protocol: 'openai',
    provider_enabled: 1,
    target_enabled: 1,
  })
  const alias = (aliasName: string, groupId: string | null, targets: unknown[]) => ({
    protocol: 'openai',
    alias_name: aliasName,
    group_id: groupId,
    group_name: groupId ? 'Production' : null,
    enabled: 1,
    thinking_json: null,
    provider_id: targets.length ? 'p1' : null,
    model_id: targets.length ? 'mm-x' : null,
    created_at: ts,
    updated_at: ts,
    provider_name: targets.length ? 'Primary' : null,
    provider_protocol: targets.length ? ('openai' as const) : null,
    provider_enabled: 1,
    target_enabled: 1,
    targets,
  })
  const aliases = [
    alias('alias-a', 'g1', [target(1, 'alias-a')]),
    alias('alias-b', null, [target(2, 'alias-b')]),
    alias('dead-alias', null, []),
  ]
  const imported: Array<{ alias_name: string; group_id: string | null }> = []
  const deleted: string[] = []
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  await page.route('**/api/alias-groups', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [{ protocol: 'openai', id: 'g1', name: 'Production', created_at: ts, updated_at: ts, alias_count: 1, enabled_count: 1 }] }) }))
  await page.route('**/api/providers', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }))
  await page.route('**/api/models', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }))
  await page.route('**/api/aliases', async (route) => {
    const method = route.request().method()
    if (method === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { alias_name: string; group_id: string | null }
      imported.push(body)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { protocol: 'openai', alias_name: body.alias_name } }) })
      return
    }
    if (method === 'DELETE') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { alias_name: string }
      deleted.push(body.alias_name)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: aliases }) })
  })

  await page.goto('/models')
  await expect(page.getByRole('heading', { name: '模型映射' })).toBeVisible()
  await page.locator('section button[aria-expanded]').first().click()
  await expect(page.getByText('alias-a')).toBeVisible()

  // 分组编辑：导入映射名，支持模糊搜索
  await page.getByRole('button', { name: '向分组 Production 导入映射' }).click()
  const importDialog = page.getByRole('dialog')
  await expect(importDialog.getByText('导入映射到分组「Production」')).toBeVisible()
  // 已在目标分组内的映射不出现在候选里
  await expect(importDialog.getByLabel('选择 alias-a')).toHaveCount(0)
  await expect(importDialog.getByLabel('选择 alias-b')).toBeVisible()
  await expect(importDialog.getByLabel('选择 dead-alias')).toBeVisible()
  await importDialog.getByPlaceholder('模糊搜索映射名…').fill('dead')
  await expect(importDialog.getByLabel('选择 alias-b')).toHaveCount(0)
  await importDialog.getByLabel('选择 dead-alias').check()
  await importDialog.getByRole('button', { name: /^导入 1 个$/ }).click()
  await expect.poll(() => imported).toEqual([{ protocol: 'openai', alias_name: 'dead-alias', group_id: 'g1' }])
  await expect(page.getByText('已导入 1 个映射至分组「Production」')).toBeVisible()

  // 一键删除无效映射（无候选目标）
  const cleanup = page.getByRole('button', { name: /清理无效映射（1）/ })
  await expect(cleanup).toBeVisible()
  page.on('dialog', (confirmDialog) => confirmDialog.accept())
  await cleanup.click()
  await expect.poll(() => deleted).toEqual(['dead-alias'])
  await expect(page.getByText('已清理 1 个无效映射')).toBeVisible()
})

test('creates an alias via searchable model selection and real-model name fill', async ({ page }) => {
  const ts = '2026-09-06T00:00:00.000Z'
  let createBody: Record<string, unknown> | null = null
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  await page.route('**/api/alias-groups', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }))
  await page.route('**/api/aliases', async (route) => {
    if (route.request().method() === 'POST') {
      createBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { protocol: 'openai', alias_name: createBody.alias_name } }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) })
  })
  await page.route('**/api/providers', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [{ id: 'p1', name: 'Primary', protocol: 'openai', group_id: null, base_url: 'https://api.example.test', auth: {}, custom_headers: {}, enabled: 1, created_at: ts, updated_at: ts }] }) }))
  await page.route('**/api/models', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [
    { provider_id: 'p1', model_id: 'gpt-4o', display_name: 'GPT-4o Omni', enabled: 1, source: 'manual', protocol: 'openai', provider_name: 'Primary', provider_enabled: 1, created_at: ts, updated_at: ts },
    { provider_id: 'p1', model_id: 'gpt-4o-mini', display_name: null, enabled: 1, source: 'manual', protocol: 'openai', provider_name: 'Primary', provider_enabled: 1, created_at: ts, updated_at: ts },
    { provider_id: 'p1', model_id: 'o3', display_name: null, enabled: 1, source: 'manual', protocol: 'openai', provider_name: 'Primary', provider_enabled: 1, created_at: ts, updated_at: ts },
  ] }) }))

  await page.goto('/models')
  await expect(page.getByRole('heading', { name: '模型映射' })).toBeVisible()
  await page.getByRole('button', { name: /新建映射/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '新建模型映射' })).toBeVisible()

  // 选择 Provider（下拉顺序：协议、分组、Provider）
  await dialog.getByRole('combobox').nth(2).click()
  await page.getByRole('option', { name: 'Primary' }).click()

  // 模糊搜索真实模型并选择；映射名为空时自动填入真实模型名
  await dialog.getByRole('combobox', { name: '当前目标' }).click()
  await dialog.getByPlaceholder('模糊搜索真实模型…').fill('mini')
  await dialog.getByRole('option', { name: 'gpt-4o-mini' }).click()
  await expect(dialog.getByPlaceholder('my-brain')).toHaveValue('gpt-4o-mini')

  // 改选其他模型后，可用按钮直接把真实模型名填为映射名
  await dialog.getByRole('combobox', { name: '当前目标' }).click()
  await dialog.getByPlaceholder('模糊搜索真实模型…').fill('o3')
  await dialog.getByRole('option', { name: 'o3' }).click()
  await expect(dialog.getByPlaceholder('my-brain')).toHaveValue('gpt-4o-mini')
  await dialog.getByRole('button', { name: '填入真实模型名' }).click()
  await expect(dialog.getByPlaceholder('my-brain')).toHaveValue('o3')

  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect.poll(() => createBody).toMatchObject({ protocol: 'openai', alias_name: 'o3', provider_id: 'p1', model_id: 'o3' })
})

test('adds a candidate target by searching models across providers', async ({ page }) => {
  const ts = '2026-09-06T00:00:00.000Z'
  let addTargetBody: Record<string, unknown> | null = null
  await page.addInitScript(() => localStorage.setItem('llm_gateway_token', 'mock-token'))
  await page.route('**/api/alias-groups', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [] }) }))
  await page.route('**/api/providers', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [
    { id: 'p1', name: 'Primary', protocol: 'openai', group_id: null, base_url: 'https://api.example.test', auth: {}, custom_headers: {}, enabled: 1, created_at: ts, updated_at: ts },
    { id: 'p2', name: 'Other', protocol: 'openai', group_id: null, base_url: 'https://other.example.test', auth: {}, custom_headers: {}, enabled: 1, created_at: ts, updated_at: ts },
  ] }) }))
  await page.route('**/api/models', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [
    { provider_id: 'p1', model_id: 'gpt-a', display_name: null, enabled: 1, source: 'manual', protocol: 'openai', provider_name: 'Primary', provider_enabled: 1, created_at: ts, updated_at: ts },
    { provider_id: 'p2', model_id: 'canary-model', display_name: null, enabled: 1, source: 'manual', protocol: 'openai', provider_name: 'Other', provider_enabled: 1, created_at: ts, updated_at: ts },
    { provider_id: 'p2', model_id: 'canary-mini', display_name: 'Canary Mini', enabled: 1, source: 'manual', protocol: 'openai', provider_name: 'Other', provider_enabled: 1, created_at: ts, updated_at: ts },
  ] }) }))
  await page.route('**/api/alias-targets', async (route) => {
    if (route.request().method() === 'POST') {
      addTargetBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { id: 9, protocol: 'openai', alias_name: addTargetBody.alias_name, provider_id: addTargetBody.provider_id, model_id: addTargetBody.model_id, priority: 1, active: 0, created_at: ts, updated_at: ts } }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) })
  })
  await page.route('**/api/aliases', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: [{
    protocol: 'openai',
    alias_name: 'alias-a',
    group_id: null,
    group_name: null,
    enabled: 1,
    thinking_json: null,
    provider_id: 'p1',
    model_id: 'gpt-a',
    created_at: ts,
    updated_at: ts,
    provider_name: 'Primary',
    provider_protocol: 'openai',
    provider_enabled: 1,
    target_enabled: 1,
    targets: [{ id: 1, protocol: 'openai', alias_name: 'alias-a', provider_id: 'p1', model_id: 'gpt-a', priority: 0, active: 1, created_at: ts, updated_at: ts, provider_name: 'Primary', provider_protocol: 'openai', provider_enabled: 1, target_enabled: 1 }],
  }] }) }))

  await page.goto('/models')
  await expect(page.getByRole('heading', { name: '模型映射' })).toBeVisible()
  await page.locator('section button[aria-expanded]').first().click()
  await expect(page.getByText('alias-a')).toBeVisible()
  // 展开候选面板
  await page.locator('table button[aria-expanded]').first().click()
  await expect(page.getByText('候选目标（按优先级排序，当前只使用一个）')).toBeVisible()

  // 不选 Provider 直接模糊搜索，可命中其他 Provider 的真实模型
  await page.getByRole('combobox', { name: '模型' }).click()
  await expect(page.getByRole('option', { name: 'gpt-a' })).toBeDisabled()
  await page.getByPlaceholder('模糊搜索真实模型…').fill('canary')
  await expect(page.getByRole('option', { name: 'canary-model' })).toBeVisible()
  await page.getByRole('option', { name: 'canary-model' }).click()

  // 选中后自动回填 Provider 与模型
  await expect(page.getByRole('combobox').filter({ hasText: 'Other' })).toHaveCount(1)
  await expect(page.getByRole('combobox', { name: '模型' })).toContainText('canary-model')
  await page.getByRole('button', { name: '添加' }).click()
  await expect.poll(() => addTargetBody).toMatchObject({ protocol: 'openai', alias_name: 'alias-a', provider_id: 'p2', model_id: 'canary-model' })
})
