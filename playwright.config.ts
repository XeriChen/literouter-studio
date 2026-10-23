import { defineConfig, devices } from '@playwright/test'

// E2E_GATEWAY_TOKEN 的自动回退逻辑见 test/e2e/global-setup.ts：
// 未设置时从本地开发库 data/gateway.db 读取 admin_token，读不到则登录类测试照旧跳过。
//
// 测试默认指向本机测试实例（后端 3013，与部署端口 3000 分离）；在生产机/CI 上
// 库中端口与默认值不一致时，用 E2E_GATEWAY_URL 显式指定被测实例。

const baseURL = process.env.E2E_GATEWAY_URL || 'http://127.0.0.1:3013'

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  outputDir: 'test-results/playwright',
  globalSetup: './test/e2e/global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm start',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
