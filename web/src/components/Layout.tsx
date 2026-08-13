import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { Activity, Box, ChevronRight, Home, LayoutDashboard, Menu, MessageSquare, Moon, ScrollText, Settings, Sun, X } from 'lucide-react'

const NAV_ITEMS: Array<{ to: string; label: string; caption: string; icon: LucideIcon; end?: boolean }> = [
  { to: '/', label: '总览', caption: '系统状态', icon: Home, end: true },
  { to: '/providers', label: 'Providers', caption: '上游连接', icon: LayoutDashboard },
  { to: '/models', label: 'Models', caption: '模型与映射', icon: Box },
  { to: '/logs', label: 'Logs', caption: '请求审计', icon: ScrollText },
  { to: '/playground', label: 'Playground', caption: '即时验证', icon: MessageSquare },
  { to: '/settings', label: 'Settings', caption: '网关配置', icon: Settings },
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
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col border-r border-foreground/10 bg-card/95 backdrop-blur-xl transition-transform duration-300 lg:static lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[84px] items-center gap-3 border-b border-foreground/10 px-5">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_28px_hsl(var(--accent)/.18)]">
            <Activity className="h-5 w-5" strokeWidth={2.5} />
            <span className="absolute -right-1 -top-1 status-dot" />
          </div>
          <div><div className="text-sm font-extrabold tracking-[-0.04em]">LITEROUTER</div><div className="eyebrow mt-0.5">gateway / studio</div></div>
          <button aria-label="关闭导航" className="icon-button ml-auto lg:hidden" onClick={() => setSidebarOpen(false)}><X className="h-4 w-4" /></button>
        </div>
        <div className="px-3 pt-7"><div className="eyebrow px-3 pb-3">工作区</div>
          <ul className="space-y-1">{NAV_ITEMS.map((item) => <li key={item.to}><NavLink to={item.to} end={item.end} onClick={() => setSidebarOpen(false)} className={({ isActive }) => `group relative flex items-center gap-3 rounded-md px-3 py-2.5 transition-all ${isActive ? 'bg-primary text-primary-foreground shadow-[0_8px_26px_hsl(var(--primary)/.14)]' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
            {({ isActive }) => <><item.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={isActive ? 2.5 : 1.8} /><span className="flex-1"><span className="block text-sm font-semibold">{item.label}</span><span className={`mt-0.5 block text-[10px] ${isActive ? 'text-primary-foreground/60' : 'text-muted-foreground/70'}`}>{item.caption}</span></span>{isActive && <ChevronRight className="h-4 w-4 opacity-60" />}</>}
          </NavLink></li>)}</ul>
        </div>
        <div className="mt-auto space-y-4 border-t border-foreground/10 p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="status-dot" /> 网关在线</div><div className="flex items-center justify-between"><span className="font-mono text-[10px] text-muted-foreground">BUILD 0.1.0</span><button aria-label="切换主题" onClick={cycleTheme} className="icon-button" title={theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色模式' : '浅色模式'}>{theme === 'light' ? <Sun className="h-4 w-4" /> : theme === 'dark' ? <Moon className="h-4 w-4" /> : <span className="font-mono text-[9px]">SYS</span>}</button></div></div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col"><header className="flex h-[84px] items-center gap-4 border-b border-foreground/10 bg-background/65 px-5 backdrop-blur-xl lg:px-10"><button aria-label="打开导航" className="icon-button lg:hidden" onClick={() => setSidebarOpen(true)}><Menu className="h-5 w-5" /></button><div className="flex min-w-0 items-center gap-2"><span className="eyebrow hidden sm:block">Studio /</span><span className="truncate text-sm font-bold">{current?.label ?? '总览'}</span></div><div className="ml-auto flex items-center gap-3"><span className="hidden font-mono text-[10px] text-muted-foreground md:block">LOCAL INSTANCE // 3000</span><span className="status-dot" /></div></header><main className="flex-1 px-4 py-7 sm:px-6 lg:px-10 lg:py-10"><Outlet /></main></div>
    </div>
  )
}
