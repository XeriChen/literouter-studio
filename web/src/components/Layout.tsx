import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Box,
  ChevronRight,
  Home,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Moon,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Sun,
  SunMoon,
  X,
} from 'lucide-react'
import { applyTheme, loadStoredTheme, type Theme } from '@/lib/theme'
import { CommandPalette } from '@/components/CommandPalette'

const NAV_ITEMS: Array<{ to: string; label: string; icon: LucideIcon; end?: boolean }> = [
  { to: '/', label: '总览', icon: Home, end: true },
  { to: '/providers', label: 'Providers', icon: LayoutDashboard },
  { to: '/models', label: 'Models', icon: Box },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/playground', label: 'Playground', icon: MessageSquare },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => loadStoredTheme())
  const location = useLocation()
  const current = useMemo(
    () =>
      NAV_ITEMS.find((item) =>
        item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
      ) ?? NAV_ITEMS[0],
    [location.pathname],
  )

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  useEffect(() => {
    if (theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  const cycleTheme = () =>
    setTheme((value) => (value === 'light' ? 'dark' : value === 'dark' ? 'system' : 'light'))

  return (
    <div className="surface-grid relative flex min-h-screen bg-background text-foreground selection:bg-accent selection:text-accent-foreground">
      {/* 快捷命令搜索浮层 (⌘K / Ctrl+K) */}
      <CommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        currentTheme={theme}
        onCycleTheme={cycleTheme}
      />

      {sidebarOpen && (
        <button
          aria-label="关闭导航"
          className="fixed inset-0 z-40 cursor-default bg-foreground/40 backdrop-blur-sm transition-opacity lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 侧边导航栏 (收紧至 17rem 带来更开阔的主内容视野) */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[min(17rem,85vw)] flex-col border-r border-foreground/10 bg-card/90 backdrop-blur-2xl transition-transform duration-300 ease-out lg:static lg:w-[17rem] lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
      >
        {/* 顶部 Logo 品牌区 */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-foreground/10 px-5 lg:h-[72px]">
          <div className="pulse-radar relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_24px_hsl(var(--accent)/.25)]">
            <Activity className="h-4 w-4" strokeWidth={2.5} />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[hsl(var(--success))] ring-2 ring-card" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-extrabold tracking-[-0.03em]">LITEROUTER</span>
              <span className="rounded bg-accent/15 px-1 py-0.2 font-mono text-[9px] font-bold text-accent">v0.1</span>
            </div>
            <div className="eyebrow mt-0.5">gateway / studio</div>
          </div>
          <button
            aria-label="关闭导航"
            className="icon-button ml-auto shrink-0 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 快速搜索/命令跳转按钮 */}
        <div className="px-3 pt-3.5 pb-1">
          <button
            type="button"
            onClick={() => { setSidebarOpen(false); setCommandOpen(true) }}
            className="group flex w-full items-center gap-2.5 rounded-lg border border-foreground/10 bg-muted/30 px-3 py-2 text-xs text-muted-foreground transition-all duration-150 hover:border-foreground/25 hover:bg-muted/70 hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-primary" />
            <span className="flex-1 text-left">搜索或指令...</span>
            <kbd className="rounded border border-foreground/15 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* 导航菜单列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          <div className="eyebrow px-3 pb-2 text-[10px] font-bold tracking-wider">工作区</div>
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) =>
                    `group relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition-all duration-150 ${
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/20'
                        : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <item.icon
                        className={`h-4 w-4 shrink-0 transition-transform duration-150 group-hover:scale-110 ${
                          isActive ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-foreground'
                        }`}
                        strokeWidth={isActive ? 2.5 : 2}
                      />
                      <span className="flex-1 truncate">{item.label}</span>
                      {isActive && <ChevronRight className="h-3.5 w-3.5 opacity-70" />}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>

        {/* 底部状态小部件 */}
        <div className="shrink-0 border-t border-foreground/10 p-3">
          <div className="rounded-lg border border-foreground/10 bg-muted/20 p-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="pulse-radar h-2 w-2 rounded-full bg-[hsl(var(--success))]" />
                <span className="font-mono text-[10px] font-bold text-foreground">GATEWAY READY</span>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">:{window.location.port || '3000'}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>原生协议透传</span>
              <span className="font-mono text-primary flex items-center gap-1">
                <Sparkles className="h-2.5 w-2.5" /> LIVE
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* 主工作区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部工具栏 */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-foreground/10 bg-background/70 px-4 backdrop-blur-xl sm:h-16 sm:gap-4 sm:px-6 lg:h-[72px] lg:px-8">
          <button
            aria-label="打开导航"
            className="icon-button lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* 面包屑导航 */}
          <div className="flex min-w-0 items-center gap-2">
            <span className="eyebrow hidden sm:block">Studio /</span>
            <span className="truncate text-sm font-extrabold tracking-[-0.02em]">{current?.label ?? '总览'}</span>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            {/* 顶栏快速搜索触发按钮 */}
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="hidden md:flex items-center gap-2 rounded-lg border border-foreground/10 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-all duration-150 hover:border-foreground/20 hover:bg-muted hover:text-foreground"
            >
              <Search className="h-3.5 w-3.5" />
              <span>搜索</span>
              <kbd className="rounded border border-foreground/15 bg-background/80 px-1.5 py-0.2 font-mono text-[10px]">
                ⌘K
              </kbd>
            </button>

            {/* 本地网关端口状态 */}
            <div className="hidden items-center gap-1.5 rounded-full border border-foreground/10 bg-muted/30 px-2.5 py-1 sm:flex">
              <span className="status-dot" />
              <span className="font-mono text-[10px] text-muted-foreground">
                PORT {window.location.port || '3000'}
              </span>
            </div>

            {/* 主题切换 */}
            <button
              aria-label="切换主题"
              onClick={cycleTheme}
              className="icon-button text-muted-foreground hover:text-foreground"
              title={theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色模式' : '浅色模式'}
            >
              {theme === 'light' ? (
                <Sun className="h-4 w-4 text-amber-500 transition-transform hover:rotate-45" />
              ) : theme === 'dark' ? (
                <Moon className="h-4 w-4 text-blue-400 transition-transform hover:-rotate-12" />
              ) : (
                <SunMoon className="h-4 w-4 text-primary" />
              )}
            </button>
          </div>
        </header>

        {/* 页面主视图 */}
        <main className="flex min-h-0 flex-1 flex-col px-4 py-5 sm:px-6 sm:py-8 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
