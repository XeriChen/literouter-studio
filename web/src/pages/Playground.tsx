import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Braces, ChevronRight, CircleDot, MessageSquare } from 'lucide-react'
import { api } from '@/api/client'
import type { ModelAlias } from '@/api/types'
import { ChatUI } from '@/components/ChatUI'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export default function Playground() {
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')
  const [aliasName, setAliasName] = useState('')
  const aliases = useQuery({ queryKey: ['aliases'], queryFn: () => api<ModelAlias[]>('/api/aliases') })
  const availableAliases = useMemo(() => (aliases.data ?? []).filter((a) => a.protocol === protocol && a.enabled === 1 && a.provider_id !== null && a.model_id !== null && a.provider_enabled === 1 && a.target_enabled === 1), [aliases.data, protocol])
  const activeAlias = availableAliases.find((a) => a.alias_name === aliasName) ?? null
  return <div className="page-shell flex min-h-[calc(100vh-168px)] flex-col gap-6"><div className="page-heading"><div><div className="eyebrow mb-3 flex items-center gap-2"><MessageSquare className="h-3.5 w-3.5" /> 实时请求面板</div><h1 className="page-title">Playground</h1><p className="page-description">选择一个映射，发送真实的流式请求。</p></div><div className="flex flex-wrap items-end gap-3"><div><div className="eyebrow mb-2">协议</div><Select value={protocol} onValueChange={(v) => { setProtocol(v as 'openai' | 'anthropic'); setAliasName('') }}><SelectTrigger className="w-36"><div className="flex items-center gap-2"><Braces className="h-4 w-4 text-primary" /><SelectValue /></div></SelectTrigger><SelectContent><SelectItem value="openai">openai</SelectItem><SelectItem value="anthropic">anthropic</SelectItem></SelectContent></Select></div><div><div className="eyebrow mb-2">模型映射</div><Select value={aliasName} onValueChange={setAliasName} disabled={!availableAliases.length}><SelectTrigger className="w-56"><SelectValue placeholder={!availableAliases.length ? '暂无可用映射' : '选择映射'} /></SelectTrigger><SelectContent>{availableAliases.map((a) => <SelectItem key={a.alias_name} value={a.alias_name}>{a.alias_name}</SelectItem>)}</SelectContent></Select></div></div></div><div className="console-surface flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-3 border-b border-foreground/10 px-5 py-3"><CircleDot className="h-3.5 w-3.5 text-primary" /><span className="font-mono text-[10px] text-muted-foreground">{activeAlias ? `${activeAlias.provider_name} / ${activeAlias.model_id}` : '请选择一个模型映射'}</span><ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" /></div><div className="min-h-0 flex-1"><ChatUI protocol={protocol} alias={activeAlias} /></div></div></div>
}
