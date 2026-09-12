import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import type { LucideIcon } from 'lucide-react'
import { Activity, Box, ChevronRight, Home, LayoutDashboard, Menu, MessageSquare, Moon, ScrollText, Settings, Sun, SunMoon, X } from 'lucide-react'

const NAV_ITEMS: Array<{ to: string; label: string; icon: LucideIcon; end?: boolean }> = [
  { to: '/', label: '总览', icon: Home, end: true },
  { to: '/providers', label: 'Providers', icon: LayoutDashboard },
  { to: '/models', label: 'Models', icon: Box },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/playground', label: 'Playground', icon: MessageSquare },
  { to: '/settings', label: 'Settings', icon: Settings },
]

type Theme = 'light' | 'dark' | 'system'

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', (theme === 'system' ? getSystemTheme() : theme) === 'dark')
}

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('theme')
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
  })
  const location = useLocation()
  const current = useMemo(
    () => NAV_ITEMS.find((item) => item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)) ?? NAV_ITEMS[0],
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

  const cycleTheme = () => setTheme((value) => value === 'light' ? 'dark' : value === 'dark' ? 'system' : 'light')

  return (
    <div className="surface-grid flex min-h-screen bg-background text-foreground">
      {sidebarOpen && <button aria-label="关闭导航" className="fixed inset-0 z-40 cursor-default bg-foreground/55 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[240px] max-w-[80vw] flex-col border-r border-foreground/15 bg-card/95 backdrop-blur-xl transition-transform duration-300 sm:w-[256px] lg:static lg:w-[256px] lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-foreground/10 px-4 sm:h-16 sm:px-5 lg:h-[84px]">
          <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_28px_hsl(var(--accent)/.18)] sm:h-9 sm:w-9 lg:h-10 lg:w-10">
            <Activity className="h-4 w-4 sm:h-5 sm:w-5" strokeWidth={2.5} />
            <span className="absolute -right-1 -top-1 status-dot" />
          </div>
          <div className="min-w-0 flex-1"><div className="truncate text-xs font-extrabold tracking-[-0.04em] sm:text-sm">LITEROUTER</div><div className="eyebrow mt-0.5 text-[9px]">gateway / studio</div></div>
          <button aria-label="关闭导航" className="icon-button ml-auto shrink-0 lg:hidden" onClick={() => setSidebarOpen(false)}><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 lg:py-6">
          <div className="eyebrow px-3 pb-1.5 text-[10px]">工作区</div>
          <ul className="space-y-0.5 sm:space-y-1">{NAV_ITEMS.map((item) => <li key={item.to}><NavLink to={item.to} end={item.end} onClick={() => setSidebarOpen(false)} className={({ isActive }) => `group relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all sm:gap-3 sm:py-2 sm:text-sm ${isActive ? 'bg-primary text-primary-foreground shadow-[0_4px_20px_hsl(var(--primary)/.14)]' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
            {({ isActive }) => <><item.icon className="h-4 w-4 shrink-0" strokeWidth={isActive ? 2.5 : 1.8} /><span className="flex-1 truncate">{item.label}</span>{isActive && <ChevronRight className="h-3.5 w-3.5 opacity-60" />}</>}
          </NavLink></li>)}</ul>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-foreground/10 bg-background/65 px-4 backdrop-blur-xl sm:h-16 sm:gap-4 sm:px-6 lg:h-[84px] lg:px-10">
          <button aria-label="打开导航" className="icon-button lg:hidden" onClick={() => setSidebarOpen(true)}><Menu className="h-5 w-5" /></button>
          <div className="flex min-w-0 items-center gap-2"><span className="eyebrow hidden sm:block">Studio /</span><span className="truncate text-sm font-bold">{current?.label ?? '总览'}</span></div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[10px] text-muted-foreground md:block">LOCAL INSTANCE // 3000</span>
            <span className="status-dot" />
            <button aria-label="切换主题" onClick={cycleTheme} className="icon-button h-8 w-8 text-muted-foreground hover:text-foreground" title={theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色模式' : '浅色模式'}>{theme === 'light' ? <Sun className="h-4 w-4" /> : theme === 'dark' ? <Moon className="h-4 w-4" /> : <SunMoon className="h-4 w-4" />}</button>
          </div>
        </header>
        <main className="flex-1 px-3 py-4 sm:px-6 sm:py-7 lg:px-10 lg:py-10"><Outlet /></main>
      </div>
    </div>
  )
}
