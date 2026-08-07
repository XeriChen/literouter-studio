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
    queryFn: () => api<{ ok: true; data: Provider[] }>('/api/providers').then((r) => r.data),
  })
  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<{ ok: true; data: ProviderModel[] }>('/api/models').then((r) => r.data),
  })

  const providersOfProtocol = useMemo(
    () => (providers.data ?? []).filter((p) => p.protocol === protocol && p.enabled === 1),
    [providers.data, protocol],
  )
  const modelsOfProvider = useMemo(
    () => (models.data ?? []).filter((m) => m.provider_id === providerId && m.protocol === protocol),
    [models.data, providerId, protocol],
  )
  const activeProvider = providersOfProtocol.find((p) => p.id === providerId) ?? null
  const activeModel = modelsOfProvider.find((m) => `${m.provider_id}/${m.model_id}` === modelKey) ?? null

  return (
    <div className="flex h-full flex-col space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label>协议</Label>
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
        <div className="space-y-1">
          <Label>Provider</Label>
          <Select value={providerId} onValueChange={(id) => { setProviderId(id); setModelKey('') }} disabled={providersOfProtocol.length === 0}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="选择 Provider" />
            </SelectTrigger>
            <SelectContent>
              {providersOfProtocol.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>模型（仅启用）</Label>
          <Select value={modelKey} onValueChange={setModelKey} disabled={modelsOfProvider.length === 0}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {modelsOfProvider.map((m) => (
                <SelectItem key={`${m.provider_id}/${m.model_id}`} value={`${m.provider_id}/${m.model_id}`} disabled={m.enabled !== 1 || m.provider_enabled !== 1}>
                  {m.model_id} {m.enabled !== 1 ? '（未启用）' : m.provider_enabled !== 1 ? '（Provider 禁用）' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ChatUI protocol={protocol} provider={activeProvider} model={activeModel} />
      </div>
    </div>
  )
}