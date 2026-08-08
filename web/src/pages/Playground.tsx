import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { Provider, ProviderModel } from '@/api/types'
import { ChatUI } from '@/components/ChatUI'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export default function Playground() {
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')
  const [providerId, setProviderId] = useState('')
  const [modelKey, setModelKey] = useState('')

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<Provider[]>('/api/providers'),
  })
  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<ProviderModel[]>('/api/models'),
  })

  const providersOfProtocol = useMemo(
    () => (providers.data ?? []).filter((p) => p.protocol === protocol && p.enabled === 1),
    [providers.data, protocol],
  )
  const modelsOfProvider = useMemo(
    () => (models.data ?? []).filter((m) => m.provider_id === providerId && m.protocol === protocol && m.enabled === 1 && m.provider_enabled === 1),
    [models.data, providerId, protocol],
  )
  const activeProvider = providersOfProtocol.find((p) => p.id === providerId) ?? null
  const activeModel = modelsOfProvider.find((m) => `${m.provider_id}/${m.model_id}` === modelKey) ?? null

  return (
    <div className="flex h-full flex-col space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Playground</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">选择模型，发起对话测试</p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">协议</Label>
            <Select
              value={protocol}
              onValueChange={(v) => {
                setProtocol(v as 'openai' | 'anthropic')
                setProviderId('')
                setModelKey('')
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
            <Label className="text-xs">Provider</Label>
            <Select value={providerId} onValueChange={(id) => { setProviderId(id); setModelKey('') }} disabled={providersOfProtocol.length === 0}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder={providersOfProtocol.length === 0 ? '请先添加 Provider' : '选择 Provider'} />
              </SelectTrigger>
              <SelectContent>
                {providersOfProtocol.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">模型</Label>
            <Select value={modelKey} onValueChange={setModelKey} disabled={modelsOfProvider.length === 0}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder={modelsOfProvider.length === 0 ? '请先拉取或添加模型' : '选择模型'} />
              </SelectTrigger>
              <SelectContent>
                {modelsOfProvider.map((m) => (
                  <SelectItem key={`${m.provider_id}/${m.model_id}`} value={`${m.provider_id}/${m.model_id}`}>
                    {m.display_name || m.model_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ChatUI protocol={protocol} provider={activeProvider} model={activeModel} />
      </div>
    </div>
  )
}
