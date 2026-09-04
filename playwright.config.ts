import { defineConfig, devices } from '@playwright/test'

// E2E_GATEWAY_TOKEN 的自动回退逻辑见 test/e2e/global-setup.ts：
// 未设置时从本地开发库 data/gateway.db 读取 admin_token，读不到则登录类测试照旧跳过。

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  outputDir: 'test-results/playwright',
  globalSetup: './test/e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3000',
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
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
