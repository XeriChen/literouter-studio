import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Braces, ChevronRight, CircleDot, Cpu, MessageSquare, Sparkles, Zap } from 'lucide-react'
import { api } from '@/api/client'
import type { ModelAlias } from '@/api/types'
import { ChatUI } from '@/components/ChatUI'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export default function Playground() {
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')
  const [aliasName, setAliasName] = useState('')
  const aliases = useQuery({ queryKey: ['aliases'], queryFn: () => api<ModelAlias[]>('/api/aliases') })
  const availableAliases = useMemo(
    () =>
      (aliases.data ?? []).filter(
        (a) =>
          a.protocol === protocol &&
          a.enabled === 1 &&
          a.provider_id !== null &&
          a.model_id !== null &&
          a.provider_enabled === 1 &&
          a.target_enabled === 1,
      ),
    [aliases.data, protocol],
  )
  const activeAlias = useMemo(
    () => availableAliases.find((a) => a.alias_name === aliasName) ?? null,
    [availableAliases, aliasName],
  )

  return (
    <div className="page-shell flex min-h-0 flex-1 flex-col gap-3.5 sm:gap-6">
      <div className="page-heading pb-3 sm:pb-6">
        <div>
          <div className="eyebrow mb-1 sm:mb-2 flex items-center gap-2">
            <span className="pulse-radar h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="font-semibold text-foreground/80">实时请求面板 / 调试沙盒</span>
          </div>
          <h1 className="page-title text-2xl sm:text-3xl">Playground</h1>
          <p className="page-description hidden sm:block">
            选择一个模型映射，向本地网关发送真实流式请求并验证路由策略。
          </p>
        </div>

        <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:flex sm:items-end sm:gap-3">
          <div>
            <div className="eyebrow mb-1.5 flex items-center justify-between">
              <span>协议协议</span>
              <span className="text-[9px] uppercase font-bold text-muted-foreground">{protocol}</span>
            </div>
            <Select
              value={protocol}
              onValueChange={(v) => {
                setProtocol(v as 'openai' | 'anthropic')
                setAliasName('')
              }}
            >
              <SelectTrigger className="w-full sm:w-40 bg-card">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      protocol === 'openai' ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span>openai</span>
                  </div>
                </SelectItem>
                <SelectItem value="anthropic">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    <span>anthropic</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="eyebrow mb-1.5 flex items-center justify-between">
              <span>模型映射</span>
              <span className="text-[9px] text-muted-foreground">{availableAliases.length} 可用</span>
            </div>
            <Select value={aliasName} onValueChange={setAliasName} disabled={!availableAliases.length}>
              <SelectTrigger className="w-full sm:w-60 bg-card">
                <SelectValue placeholder={!availableAliases.length ? '暂无可用映射' : '选择映射'} />
              </SelectTrigger>
              <SelectContent>
                {availableAliases.map((a) => (
                  <SelectItem key={a.alias_name} value={a.alias_name}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono font-bold text-foreground">{a.alias_name}</span>
                      <span className="text-[10px] text-muted-foreground truncate">
                        {a.provider_name}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="console-surface flex min-h-0 flex-1 flex-col shadow-sm">
        {/* 顶部链路状态指示条 */}
        <div className="flex items-center gap-3 border-b border-foreground/10 bg-muted/20 px-4 py-2.5 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                activeAlias ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-muted-foreground'
              }`}
            />
            <span className="font-mono text-xs font-bold text-foreground">
              {activeAlias ? activeAlias.alias_name : '未选择映射'}
            </span>
          </div>

          {activeAlias && (
            <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground font-mono">
              <span>→</span>
              <span className="rounded bg-background/80 px-2 py-0.5 border border-foreground/10 text-foreground font-medium">
                {activeAlias.provider_name} / {activeAlias.model_id}
              </span>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground uppercase">
              {protocol === 'openai' ? 'STREAM: SSE / CHAT' : 'STREAM: SSE / MESSAGES'}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <ChatUI protocol={protocol} alias={activeAlias} />
        </div>
      </div>
    </div>
  )
}
