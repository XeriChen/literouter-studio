import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { ModelAlias } from '@/api/types'
import { ChatUI } from '@/components/ChatUI'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export default function Playground() {
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')
  const [aliasName, setAliasName] = useState('')

  const aliases = useQuery({
    queryKey: ['aliases'],
    queryFn: () => api<ModelAlias[]>('/api/aliases'),
  })

  const availableAliases = useMemo(
    () =>
      (aliases.data ?? []).filter(
        (a) => a.protocol === protocol && a.provider_enabled === 1 && a.target_enabled === 1,
      ),
    [aliases.data, protocol],
  )
  const activeAlias = availableAliases.find((a) => a.alias_name === aliasName) ?? null

  return (
    <div className="flex h-full flex-col space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Playground</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">选择模型映射，发起对话测试</p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">协议</Label>
            <Select
              value={protocol}
              onValueChange={(v) => {
                setProtocol(v as 'openai' | 'anthropic')
                setAliasName('')
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">openai</SelectItem>
                <SelectItem value="anthropic">anthropic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">模型映射</Label>
            <Select value={aliasName} onValueChange={setAliasName} disabled={availableAliases.length === 0}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder={availableAliases.length === 0 ? '请先建立模型映射' : '选择映射'} />
              </SelectTrigger>
              <SelectContent>
                {availableAliases.map((a) => (
                  <SelectItem key={a.alias_name} value={a.alias_name}>
                    {a.alias_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeAlias && (
              <p className="text-xs text-muted-foreground">
                → {activeAlias.provider_name} / {activeAlias.model_id}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ChatUI protocol={protocol} alias={activeAlias} />
      </div>
    </div>
  )
}