/**
 * 简单 UI 检查脚本（一次性，不入正式测试套件）
 * 用 Playwright 连真实后端（pnpm start），逐页检查：
 *  - 页面标题渲染
 *  - 控制台错误 / 页面异常
 *  - 水平溢出（桌面 1440px 与移动 390px）
 *  - 主题切换（浅色 → 深色 → 跟随系统）
 *  - 移动端抽屉导航开合
 * 截图输出到 test-results/ui-check/
 */
import { chromium } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:3000'
const OUT = 'test-results/ui-check'
mkdirSync(OUT, { recursive: true })

// 开发库路径锚定到仓库根（不依赖进程 cwd）
const DB_PATH = fileURLToPath(new URL('../data/gateway.db', import.meta.url))

// 从本地开发库读 admin_token（与 e2e global-setup 同源）
let token = process.env.E2E_GATEWAY_TOKEN
if (!token) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const row = db.prepare("select value from settings where key = 'admin_token'").get()
    db.close()
    token = row?.value
  } catch {}
}
if (!token) {
  console.error('未找到 gateway token（E2E_GATEWAY_TOKEN 或 data/gateway.db）')
  process.exit(1)
}

const pages = [
  { path: '/', title: '每一次请求', name: 'home' },
  { path: '/providers', title: 'Providers', name: 'providers' },
  { path: '/models', title: '模型映射', name: 'models' },
  { path: '/logs', title: 'Logs', name: 'logs' },
  { path: '/playground', title: 'Playground', name: 'playground' },
  { path: '/settings', title: 'Settings', name: 'settings' },
]

const browser = await chromium.launch()
const issues = []

async function checkPage(page, { path, title, name }, viewport) {
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)

  // 1. 页面标题
  const h1 = await page.locator('h1').first().textContent()
  const titleOk = h1?.includes(title)
  if (!titleOk) issues.push(`[${name}] h1 期望含 "${title}"，实际 "${h1?.trim()}"`)

  // 2. 水平溢出
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 1) issues.push(`[${name}] 水平溢出 ${overflow}px`)

  // 3. 截图
  await page.screenshot({ path: `${OUT}/${name}-${viewport}.png`, fullPage: true })

  // 4. 控制台错误（忽略 favicon 404 之类）
  const realErrors = errors.filter((e) => !/favicon|404/.test(e))
  if (realErrors.length) issues.push(`[${name}] 控制台错误: ${realErrors.join(' | ')}`)

  return realErrors
}

// ---------- 桌面 1440px ----------
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await desktop.goto(BASE + '/login', { waitUntil: 'networkidle' })
await desktop.getByPlaceholder('输入 gateway token').fill(token)
await desktop.getByRole('button', { name: /进入工作台/ }).click()
await desktop.waitForURL(BASE + '/')
console.log('登录成功，开始逐页检查…\n')

for (const p of pages) await checkPage(desktop, p, 'desktop')

// ---------- 主题切换 ----------
// 初始主题可能是 light/dark/system 任意一种，先读按钮 title 确认当前状态，
// 再点击一整轮（cycle: light→dark→system→light），逐点校验 html.dark 与预期一致
const titleToTheme = { 跟随系统: 'system', 深色模式: 'dark', 浅色模式: 'light' }
const themeBtn = desktop.getByRole('button', { name: '切换主题' })
const cycle = { light: 'dark', dark: 'system', system: 'light' }
const expectDark = (t) => t === 'dark' ? true : t === 'light' ? false : null // null = 跟随系统

let current = titleToTheme[await themeBtn.getAttribute('title')] ?? 'system'
for (let i = 0; i < 3; i++) {
  const next = cycle[current]
  await themeBtn.click()
  await desktop.waitForTimeout(150)
  const dark = await desktop.evaluate(() => document.documentElement.classList.contains('dark'))
  const expected = expectDark(next)
  const ok = expected === null
    ? dark === (await desktop.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches))
    : dark === expected
  if (!ok) issues.push(`[theme] 切换到 ${next} 后 html.dark=${dark}，不符合预期`)
  else console.log(`主题切换: ${current} → ${next} ✓`)
  if (next === 'dark') await desktop.screenshot({ path: `${OUT}/home-dark.png`, fullPage: true })
  current = next
}
const stored = await desktop.evaluate(() => localStorage.getItem('theme'))
if (stored !== current) issues.push(`[theme] localStorage.theme=${stored}，应为 ${current}`)

// ---------- 移动端 390px ----------
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } })
await mobile.goto(BASE + '/login', { waitUntil: 'networkidle' })
await mobile.getByPlaceholder('输入 gateway token').fill(token)
await mobile.getByRole('button', { name: /进入工作台/ }).click()
await mobile.waitForURL(BASE + '/')
for (const p of pages) await checkPage(mobile, p, 'mobile')

// 移动端抽屉导航
await mobile.getByRole('button', { name: '打开导航' }).click()
await mobile.waitForTimeout(200)
const drawerVisible = await mobile.getByRole('link', { name: 'Providers' }).isVisible()
if (!drawerVisible) issues.push('[mobile] 抽屉打开后导航不可见')
await mobile.screenshot({ path: `${OUT}/nav-drawer.png` })
await mobile.getByRole('button', { name: '关闭导航' }).last().click()
console.log('移动端抽屉导航开合 ✓')

await browser.close()

console.log('\n========== UI 检查结果 ==========')
if (issues.length === 0) {
  console.log('全部通过，未发现问题')
} else {
  console.log(`发现 ${issues.length} 个问题:`)
  for (const i of issues) console.log('  ✗ ' + i)
  process.exitCode = 1
}
