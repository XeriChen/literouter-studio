import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Box,
  Braces,
  Copy,
  Home,
  LayoutDashboard,
  MessageSquare,
  Moon,
  Route,
  ScrollText,
  Settings,
  Sparkles,
  Sun,
  SunMoon,
} from 'lucide-react'
import { api } from '@/api/client'
import type { ModelAlias, Provider } from '@/api/types'
import { copyText } from '@/lib/clipboard'
import type { Theme } from '@/lib/theme'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentTheme: Theme
  onCycleTheme: () => void
}

export function CommandPalette({ open, onOpenChange, currentTheme, onCycleTheme }: CommandPaletteProps) {
  const navigate = useNavigate()
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)

  const aliases = useQuery({
    queryKey: ['aliases'],
    queryFn: () => api<ModelAlias[]>('/api/aliases'),
    enabled: open,
  })

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<Provider[]>('/api/providers'),
    enabled: open,
  })

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [open, onOpenChange])

  function handleNavigate(to: string) {
    onOpenChange(false)
    navigate(to)
  }

  function handleCopy(path: string, label: string) {
    const full = `${window.location.origin}${path}`
    void copyText(full).then(() => {
      setCopyFeedback(label)
      setTimeout(() => {
        setCopyFeedback(null)
        onOpenChange(false)
      }, 800)
    })
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="搜索页面、模型映射、操作或快捷指令..." />
      <CommandList>
        <CommandEmpty>未找到相关指令或模型</CommandEmpty>

        <CommandGroup heading="工作区导航">
          <CommandItem onSelect={() => handleNavigate('/')}>
            <Home className="mr-2 h-4 w-4 text-primary" />
            <span>系统总览</span>
            <CommandShortcut>G H</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => handleNavigate('/providers')}>
            <LayoutDashboard className="mr-2 h-4 w-4 text-primary" />
            <span>Providers 连接管理</span>
            <CommandShortcut>G P</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => handleNavigate('/models')}>
            <Box className="mr-2 h-4 w-4 text-primary" />
            <span>Models 模型与映射</span>
            <CommandShortcut>G M</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => handleNavigate('/playground')}>
            <MessageSquare className="mr-2 h-4 w-4 text-primary" />
            <span>Playground 实时调试</span>
            <CommandShortcut>G L</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => handleNavigate('/logs')}>
            <ScrollText className="mr-2 h-4 w-4 text-primary" />
            <span>Logs 请求与审计日志</span>
            <CommandShortcut>G O</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => handleNavigate('/settings')}>
            <Settings className="mr-2 h-4 w-4 text-primary" />
            <span>Settings 系统配置</span>
            <CommandShortcut>G S</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="快捷操作">
          <CommandItem onSelect={onCycleTheme}>
            {currentTheme === 'light' ? (
              <Sun className="mr-2 h-4 w-4 text-amber-500" />
            ) : currentTheme === 'dark' ? (
              <Moon className="mr-2 h-4 w-4 text-blue-400" />
            ) : (
              <SunMoon className="mr-2 h-4 w-4 text-primary" />
            )}
            <span>
              切换主题模式 (当前：{currentTheme === 'system' ? '跟随系统' : currentTheme === 'dark' ? '深色' : '浅色'})
            </span>
            <CommandShortcut>Theme</CommandShortcut>
          </CommandItem>

          <CommandItem onSelect={() => handleCopy('/openai/v1/chat/completions', 'OpenAI Endpoint')}>
            <Copy className="mr-2 h-4 w-4 text-emerald-500" />
            <span>
              {copyFeedback === 'OpenAI Endpoint' ? '✓ 已复制完整 URL' : '复制 OpenAI 端点完整 URL'}
            </span>
            <CommandShortcut className="font-mono">/openai/v1</CommandShortcut>
          </CommandItem>

          <CommandItem onSelect={() => handleCopy('/anthropic/v1/messages', 'Anthropic Endpoint')}>
            <Copy className="mr-2 h-4 w-4 text-amber-500" />
            <span>
              {copyFeedback === 'Anthropic Endpoint' ? '✓ 已复制完整 URL' : '复制 Anthropic 端点完整 URL'}
            </span>
            <CommandShortcut className="font-mono">/anthropic/v1</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {aliases.data && aliases.data.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`模型映射快速直达 (${aliases.data.length})`}>
              {aliases.data.map((alias) => (
                <CommandItem
                  key={`${alias.protocol}/${alias.alias_name}`}
                  onSelect={() => handleNavigate(`/playground`)}
                >
                  <Route className="mr-2 h-4 w-4 text-primary" />
                  <div className="flex flex-1 items-center gap-2 overflow-hidden">
                    <span className="font-mono font-bold text-foreground truncate">{alias.alias_name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase font-mono">
                      {alias.protocol}
                    </span>
                    {alias.provider_name && (
                      <span className="truncate text-xs text-muted-foreground">
                        → {alias.provider_name} / {alias.model_id}
                      </span>
                    )}
                  </div>
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground opacity-60" />
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {providers.data && providers.data.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`已连接 Providers (${providers.data.length})`}>
              {providers.data.map((p) => (
                <CommandItem key={p.id} onSelect={() => handleNavigate('/providers')}>
                  <Braces className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="font-medium text-foreground">{p.name}</span>
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground uppercase">
                    {p.protocol}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground truncate max-w-[140px]">
                    {p.base_url}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
