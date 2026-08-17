import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  ServerOff,
  Trash2,
  Unlock,
  Wifi,
  X,
} from 'lucide-react'
import { api } from '@/api/client'
import type { Provider, ProviderGroup } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type Protocol = Provider['protocol']
type FormMode = 'create' | 'edit' | 'copy'

interface ProviderForm {
  name: string
  protocol: Protocol
  group_id: string
  base_url: string
  api_key: string
  anthropic_version: string
  proxy_url: string
  timeout_ms: string
  custom_headers: string
  model_filter: string
}

const EMPTY_FORM: ProviderForm = {
  name: '',
  protocol: 'openai',
  group_id: '',
  base_url: '',
  api_key: '',
  anthropic_version: '',
  proxy_url: '',
  timeout_ms: '',
  custom_headers: '{}',
  model_filter: '',
}

const PROTOCOLS: Protocol[] = ['openai', 'anthropic']

export default function Providers() {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [formMode, setFormMode] = useState<FormMode>('create')
  const [editing, setEditing] = useState<Provider | null>(null)
  const [form, setForm] = useState<ProviderForm>({ ...EMPTY_FORM })
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [result, setResult] = useState<{ message: string; ok: boolean } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupForm, setGroupForm] = useState<{ protocol: Protocol; name: string }>({ protocol: 'openai', name: '' })
  const [groupDialogSource, setGroupDialogSource] = useState<'page' | 'provider'>('page')
  const [renaming, setRenaming] = useState<{ protocol: Protocol; id: string; name: string } | null>(null)
  const [selectedProviderIds, setSelectedProviderIds] = useState<Set<string>>(new Set())
  const [fetchDialog, setFetchDialog] = useState<{ providerId: string; providerName: string } | null>(null)
  const [upstreamModels, setUpstreamModels] = useState<string[]>([])
  const [upstreamLoading, setUpstreamLoading] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [modelSearch, setModelSearch] = useState('')

  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('/api/providers') })
  const providerGroups = useQuery({ queryKey: ['provider-groups'], queryFn: () => api<ProviderGroup[]>('/api/provider-groups') })
  const selectedProviders = useMemo(
    () => (providers.data ?? []).filter((provider) => selectedProviderIds.has(provider.id)),
    [providers.data, selectedProviderIds],
  )
  const selectedProtocol = selectedProviders.length > 0 && new Set(selectedProviders.map((provider) => provider.protocol)).size === 1
    ? selectedProviders[0]?.protocol ?? null
    : null

  useEffect(() => {
    if (!providers.data) return
    const existingIds = new Set(providers.data.map((provider) => provider.id))
    setSelectedProviderIds((current) => {
      const next = new Set([...current].filter((id) => existingIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [providers.data])

  function invalidateProviderData() {
    qc.invalidateQueries({ queryKey: ['providers'] })
    qc.invalidateQueries({ queryKey: ['provider-groups'] })
    qc.invalidateQueries({ queryKey: ['models'] })
    qc.invalidateQueries({ queryKey: ['aliases'] })
  }

  function formFromProvider(provider: Provider, name = provider.name): ProviderForm {
    return {
      name,
      protocol: provider.protocol,
      group_id: provider.group_id ?? '',
      base_url: provider.base_url,
      api_key: provider.auth.api_key ?? '',
      anthropic_version: provider.auth.version ?? '',
      proxy_url: provider.proxy_url ?? '',
      timeout_ms: provider.timeout_ms == null ? '' : String(provider.timeout_ms),
      custom_headers: JSON.stringify(provider.custom_headers ?? {}, null, 2),
      model_filter: provider.model_filter ?? '',
    }
  }

  function openCreate() {
    setEditing(null)
    setFormMode('create')
    setForm({ ...EMPTY_FORM })
    setApiKeyVisible(false)
    setDialogOpen(true)
  }

  function openGroupDialog(protocol: Protocol = 'openai', source: 'page' | 'provider' = 'page') {
    setGroupDialogSource(source)
    setGroupForm({ protocol, name: '' })
    setGroupOpen(true)
  }

  function openEdit(provider: Provider) {
    setEditing(provider)
    setFormMode('edit')
    setForm(formFromProvider(provider))
    setApiKeyVisible(false)
    setDialogOpen(true)
  }

  function openCopy(provider: Provider) {
    setEditing(null)
    setFormMode('copy')
    setForm(formFromProvider(provider, `${provider.name} 副本`))
    setApiKeyVisible(false)
    setDialogOpen(true)
  }

  /** 将 API Key 输入的内容按 Base64 解码并直接回填。 */
  function decodeApiKey() {
    const raw = form.api_key.replace(/\s+/g, '')
    if (!raw) {
      setResult({ message: '请先输入要解码的内容', ok: false })
      return
    }
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
    if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      setResult({ message: '输入内容不是合法的 Base64', ok: false })
      return
    }
    try {
      const bin = atob(normalized)
      const bytes = Uint8Array.from(bin, (character) => character.charCodeAt(0))
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      setForm({ ...form, api_key: decoded })
      setResult({ message: '已解码为明文并回填', ok: true })
    } catch {
      setResult({ message: 'Base64 解码失败（内容可能不是文本）', ok: false })
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const auth: Record<string, string> = {}
      if (form.api_key) auth.api_key = form.api_key
      if (form.protocol === 'anthropic' && form.anthropic_version.trim()) auth.version = form.anthropic_version.trim()
      let custom_headers: Record<string, string> = {}
      try {
        custom_headers = JSON.parse(form.custom_headers || '{}')
      } catch {
        throw new Error('自定义请求头必须是合法 JSON 对象')
      }
      const body = {
        name: form.name,
        protocol: form.protocol,
        group_id: form.group_id || null,
        base_url: form.base_url,
        auth,
        proxy_url: form.proxy_url.trim() || null,
        timeout_ms: form.timeout_ms.trim() ? Number(form.timeout_ms) : null,
        model_filter: form.model_filter.trim() || null,
        custom_headers,
      }
      if (editing) return api(`/api/providers/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) })
      return api('/api/providers', { method: 'POST', body: JSON.stringify(body) })
    },
    onSuccess: () => {
      setDialogOpen(false)
      invalidateProviderData()
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '保存失败', ok: false }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/api/providers/${id}`, { method: 'DELETE' }),
    onSuccess: invalidateProviderData,
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '删除失败', ok: false }),
  })

  const toggleMutation = useMutation({
    mutationFn: (provider: Provider) => api(`/api/providers/${provider.id}`, { method: 'PUT', body: JSON.stringify({ enabled: provider.enabled ? 0 : 1 }) }),
    onSuccess: invalidateProviderData,
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '更新失败', ok: false }),
  })

  const batchSetEnabledMutation = useMutation({
    mutationFn: async ({ providerIds, enabled }: { providerIds: string[]; enabled: 0 | 1 }) => {
      await Promise.all(providerIds.map((id) => api(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) })))
    },
    onSuccess: (_data, variables) => {
      setSelectedProviderIds(new Set())
      invalidateProviderData()
      setResult({ message: variables.enabled ? '批量启用完成' : '批量禁用完成', ok: true })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '批量更新失败', ok: false }),
  })

  const batchDeleteMutation = useMutation({
    mutationFn: async (providerIds: string[]) => {
      await Promise.all(providerIds.map((id) => api(`/api/providers/${id}`, { method: 'DELETE' })))
    },
    onSuccess: () => {
      setSelectedProviderIds(new Set())
      invalidateProviderData()
      setResult({ message: '批量删除完成', ok: true })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '批量删除失败', ok: false }),
  })

  const batchMoveMutation = useMutation({
    mutationFn: async ({ providerIds, groupId }: { providerIds: string[]; groupId: string | null }) => {
      await Promise.all(providerIds.map((id) => api(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify({ group_id: groupId }) })))
    },
    onSuccess: () => {
      setSelectedProviderIds(new Set())
      invalidateProviderData()
      setResult({ message: '批量移动分组完成', ok: true })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '批量移动失败', ok: false }),
  })

  const createGroupMutation = useMutation({
    mutationFn: () => api<ProviderGroup>('/api/provider-groups', { method: 'POST', body: JSON.stringify({ ...groupForm, name: groupForm.name.trim() }) }),
    onSuccess: (group) => {
      setGroupOpen(false)
      setGroupForm({ protocol: 'openai', name: '' })
      if (groupDialogSource === 'provider') setForm((current) => ({ ...current, group_id: group.id }))
      qc.invalidateQueries({ queryKey: ['provider-groups'] })
      setResult({ message: 'Provider 分组创建成功', ok: true })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '创建分组失败', ok: false }),
  })

  const renameGroupMutation = useMutation({
    mutationFn: (input: { protocol: Protocol; group_id: string; name: string }) => api('/api/provider-groups', { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => {
      setRenaming(null)
      qc.invalidateQueries({ queryKey: ['provider-groups'] })
      setResult({ message: 'Provider 分组名称已更新', ok: true })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '重命名失败', ok: false }),
  })

  const groupActionMutation = useMutation({
    mutationFn: ({ action, group, enabled }: { action: 'toggle-enabled' | 'clear' | 'delete'; group: ProviderGroup; enabled?: 0 | 1 }) => {
      const path = action === 'toggle-enabled'
        ? '/api/provider-groups/batch-toggle'
        : action === 'clear'
          ? '/api/provider-groups/batch-delete'
          : '/api/provider-groups'
      return api(path, { method: action === 'delete' ? 'DELETE' : 'POST', body: JSON.stringify({ protocol: group.protocol, group_id: group.id, ...(action === 'toggle-enabled' ? { enabled } : {}) }) })
    },
    onSuccess: (_data, variables) => {
      invalidateProviderData()
      setResult({
        message: variables.action === 'toggle-enabled' ? (variables.enabled ? '分组内 Provider 已全部启用' : '分组内 Provider 已全部禁用') : variables.action === 'clear' ? '分组内 Provider 已清空' : 'Provider 分组已删除，成员移至未分组',
        ok: true,
      })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '分组操作失败', ok: false }),
  })

  const testMutation = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; status?: number; message: string }>(`/api/providers/${id}/test`, { method: 'POST' }),
    onSuccess: (data) => setResult({ message: data.message, ok: data.ok }),
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '测试失败', ok: false }),
  })

  async function openFetchDialog(id: string, name: string) {
    setFetchDialog({ providerId: id, providerName: name })
    setUpstreamModels([])
    setSelectedModels(new Set())
    setModelSearch('')
    setUpstreamLoading(true)
    try {
      const data = await api<{ model_ids: string[] }>(`/api/providers/${id}/upstream-models`, { method: 'POST' })
      setUpstreamModels(data.model_ids)
      setSelectedModels(new Set(data.model_ids))
    } catch (error) {
      setResult({ message: `拉取失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false })
      setFetchDialog(null)
    } finally {
      setUpstreamLoading(false)
    }
  }

  const importModelsMutation = useMutation({
    mutationFn: ({ providerId, modelIds }: { providerId: string; modelIds: string[] }) => api<{ added: number; updated: number }>(`/api/providers/${providerId}/import-models`, { method: 'POST', body: JSON.stringify({ model_ids: modelIds }) }),
    onSuccess: (data) => {
      setResult({ message: `导入成功：新增 ${data.added}，刷新 ${data.updated}`, ok: true })
      setFetchDialog(null)
      qc.invalidateQueries({ queryKey: ['models'] })
    },
    onError: (error) => setResult({ message: `导入失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false }),
  })

  const filteredUpstream = useMemo(() => {
    if (!modelSearch.trim()) return upstreamModels
    const query = modelSearch.trim().toLowerCase()
    return upstreamModels.filter((id) => id.toLowerCase().includes(query))
  }, [upstreamModels, modelSearch])

  function rowsFor(protocol: Protocol, groupId: string | null) {
    return (providers.data ?? []).filter((provider) => provider.protocol === protocol && provider.group_id === groupId)
  }

  function toggleGroup(key: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleProviderSelection(providerId: string) {
    setSelectedProviderIds((current) => {
      const next = new Set(current)
      if (next.has(providerId)) next.delete(providerId)
      else next.add(providerId)
      return next
    })
  }

  function toggleRowsSelection(rows: Provider[]) {
    const ids = rows.map((provider) => provider.id)
    setSelectedProviderIds((current) => {
      const next = new Set(current)
      const shouldClear = ids.length > 0 && ids.every((id) => next.has(id))
      ids.forEach((id) => shouldClear ? next.delete(id) : next.add(id))
      return next
    })
  }

  function renderProviderTable(rows: Provider[]) {
    const allSelected = rows.length > 0 && rows.every((provider) => selectedProviderIds.has(provider.id))
    return (
      <Table className="data-table">
        <TableHeader><TableRow><TableHead className="w-10 pl-4"><input type="checkbox" checked={allSelected} onChange={() => toggleRowsSelection(rows)} aria-label="选择当前分组全部 Provider" className="h-4 w-4 rounded border-input" /></TableHead><TableHead>名称</TableHead><TableHead>协议</TableHead><TableHead>Base URL</TableHead><TableHead>状态</TableHead><TableHead className="pr-6 text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((provider) => (
            <TableRow key={provider.id} className={selectedProviderIds.has(provider.id) ? 'bg-muted/50' : undefined}>
              <TableCell className="pl-4"><input type="checkbox" checked={selectedProviderIds.has(provider.id)} onChange={() => toggleProviderSelection(provider.id)} aria-label={`选择 ${provider.name}`} className="h-4 w-4 rounded border-input" /></TableCell>
              <TableCell className="font-medium">{provider.name}</TableCell>
              <TableCell><Badge variant={provider.protocol === 'openai' ? 'outline' : 'secondary'}>{provider.protocol}</Badge></TableCell>
              <TableCell className="max-w-[240px]"><a href={provider.base_url.startsWith('http://') || provider.base_url.startsWith('https://') ? provider.base_url : `https://${provider.base_url}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 truncate font-mono text-xs text-foreground underline-offset-2 hover:underline" title={provider.base_url}><ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" /><span className="truncate">{provider.base_url}</span></a></TableCell>
              <TableCell><Switch checked={!!provider.enabled} disabled={toggleMutation.isPending} onCheckedChange={() => toggleMutation.mutate(provider)} aria-label={`切换 ${provider.name} 启用状态`} /></TableCell>
              <TableCell className="pr-6"><div className="flex items-center justify-end gap-1">
                <Button variant="ghost" size="icon" className="icon-button" aria-label={`测试 ${provider.name}`} title="测试连通性" onClick={() => testMutation.mutate(provider.id)} disabled={testMutation.isPending}><Wifi className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="icon-button" aria-label={`拉取 ${provider.name} 的模型`} title="拉取模型" onClick={() => openFetchDialog(provider.id, provider.name)}><RefreshCw className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="icon-button" aria-label={`复制 ${provider.name}`} title="复制 Provider" onClick={() => openCopy(provider)}><Copy className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="icon-button" aria-label={`编辑 ${provider.name}`} title="编辑" onClick={() => openEdit(provider)}><MoreHorizontal className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" className="icon-button hover:text-destructive" aria-label={`删除 ${provider.name}`} title="删除" onClick={() => { if (window.confirm(`确定删除 Provider「${provider.name}」？关联的模型也会一并删除。`)) deleteMutation.mutate(provider.id) }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div></TableCell>
            </TableRow>
          ))}
          {!rows.length && <TableRow><TableCell colSpan={6} className="h-16 text-center text-xs text-muted-foreground">暂无 Provider，可从右上角新增。</TableCell></TableRow>}
        </TableBody>
      </Table>
    )
  }

  function renderGroup(protocol: Protocol, group: ProviderGroup | null) {
    const rows = rowsFor(protocol, group?.id ?? null)
    const key = `${protocol}/${group?.id ?? 'ungrouped'}`
    const isOpen = !collapsed.has(key)
    const enabledCount = rows.filter((provider) => provider.enabled).length
    const groupSwitchChecked = rows.length > 0 && enabledCount === rows.length
    return (
      <Card key={key} className="console-surface shadow-none">
        <CardHeader className="items-stretch justify-between gap-2 space-y-0 border-b border-foreground/10 px-5 py-3 sm:flex-row sm:items-center">
          <button className="flex min-w-0 flex-wrap items-center gap-2 text-left" onClick={() => toggleGroup(key)} aria-expanded={isOpen}>
            {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <CardTitle className="truncate text-sm font-medium">{group?.name ?? '未分组'}</CardTitle>
            <Badge variant="outline">{protocol}</Badge><Badge variant="secondary">{rows.length}</Badge>
            {group && <Badge variant="outline">{rows.filter((provider) => provider.enabled).length} 已启用</Badge>}
          </button>
          {group && <div className="flex flex-wrap items-center justify-end gap-1">
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><span>{enabledCount === rows.length && rows.length > 0 ? '全部启用' : enabledCount > 0 ? '部分启用' : '全部禁用'}</span><Switch checked={groupSwitchChecked} disabled={!rows.length || groupActionMutation.isPending} onCheckedChange={(enabled) => groupActionMutation.mutate({ action: 'toggle-enabled', group, enabled: enabled ? 1 : 0 })} aria-label={`切换 ${group.name} 内全部 Provider 启用状态`} title={groupSwitchChecked ? '禁用组内全部 Provider' : '启用组内全部 Provider'} /></div>
            <Button size="sm" variant="ghost" disabled={!rows.length || groupActionMutation.isPending} onClick={() => { if (window.confirm(`确定删除分组「${group.name}」内的 ${rows.length} 个 Provider？关联的模型和映射候选也会一并删除。`)) groupActionMutation.mutate({ action: 'clear', group }) }} title="删除组内全部 Provider"><Trash2 className="h-3.5 w-3.5" /> 清空 Provider</Button>
            <Button variant="ghost" size="icon" className="icon-button" aria-label={`重命名分组 ${group.name}`} title="重命名分组" onClick={() => setRenaming({ protocol: group.protocol, id: group.id, name: group.name })}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" className="icon-button hover:text-destructive" aria-label={`删除分组 ${group.name}`} title="删除分组" onClick={() => { if (window.confirm(`删除分组「${group.name}」？组内 Provider 会移到未分组，不会删除。`)) groupActionMutation.mutate({ action: 'delete', group }) }}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>}
        </CardHeader>
        {isOpen && <CardContent className="p-0">{renderProviderTable(rows)}</CardContent>}
      </Card>
    )
  }

  const hasAnyProvider = (providers.data?.length ?? 0) > 0

  return (
    <>
    {selectedProviderIds.size > 0 && <div className="fixed inset-x-3 bottom-4 z-[90] mx-auto flex max-w-fit flex-wrap items-center justify-center gap-2 rounded-lg border bg-card px-3 py-2.5 shadow-xl sm:gap-3 sm:px-5 sm:py-3">
      <span className="text-sm font-medium">已选 {selectedProviderIds.size} 个 Provider</span>
      <div className="hidden h-4 w-px bg-border sm:block" />
      <Select
        onValueChange={(groupId) => batchMoveMutation.mutate({ providerIds: [...selectedProviderIds], groupId: groupId === 'none' ? null : groupId })}
        disabled={!selectedProtocol || batchMoveMutation.isPending || batchSetEnabledMutation.isPending || batchDeleteMutation.isPending}
      >
        <SelectTrigger className="h-8 w-[170px] max-w-full text-xs" aria-label="批量移动 Provider 到分组">
          <SelectValue placeholder={selectedProtocol ? '移动到分组' : '需选择同一协议'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">未分组</SelectItem>
          {(providerGroups.data ?? []).filter((group) => group.protocol === selectedProtocol).map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" onClick={() => batchSetEnabledMutation.mutate({ providerIds: [...selectedProviderIds], enabled: 1 })} disabled={batchSetEnabledMutation.isPending || batchMoveMutation.isPending || batchDeleteMutation.isPending}><Power className="h-3.5 w-3.5" /> 启用</Button>
      <Button size="sm" variant="outline" onClick={() => batchSetEnabledMutation.mutate({ providerIds: [...selectedProviderIds], enabled: 0 })} disabled={batchSetEnabledMutation.isPending || batchMoveMutation.isPending || batchDeleteMutation.isPending}>禁用</Button>
      <Button size="sm" variant="outline" onClick={() => { if (window.confirm(`确定删除选中的 ${selectedProviderIds.size} 个 Provider？关联的模型也会一并删除。`)) batchDeleteMutation.mutate([...selectedProviderIds]) }} disabled={batchSetEnabledMutation.isPending || batchMoveMutation.isPending || batchDeleteMutation.isPending}><Trash2 className="h-3.5 w-3.5" /> 删除</Button>
      <Button size="sm" variant="ghost" onClick={() => setSelectedProviderIds(new Set())} aria-label="清除 Provider 选择"><X className="h-3.5 w-3.5" /></Button>
    </div>}
    <div className="page-shell space-y-6">
      <div className="page-heading">
        <div><div className="eyebrow mb-2 flex items-center gap-2"><Wifi className="h-3.5 w-3.5" /> 上游连接</div><h1 className="page-title">Providers</h1><p className="page-description">按协议和自定义分组管理 LLM 服务接入点、连通性与模型发现。</p></div>
        <div className="flex flex-wrap items-center gap-2"><Button variant="outline" onClick={() => openGroupDialog()} size="sm"><FolderPlus className="h-4 w-4" /> 新建分组</Button><Button onClick={openCreate} size="sm"><Plus className="h-4 w-4" /> 新增 Provider</Button></div>
      </div>

      {result && <div className={`notice ${result.ok ? 'notice-success' : 'notice-error'}`}><span>{result.message}</span><button aria-label="关闭提示" onClick={() => setResult(null)} className="icon-button ml-auto h-6 w-6"><X className="h-3.5 w-3.5" /></button></div>}

      <div className="space-y-4">
        {PROTOCOLS.map((protocol) => {
          const protocolGroups = (providerGroups.data ?? []).filter((group) => group.protocol === protocol)
          const protocolRows = (providers.data ?? []).filter((provider) => provider.protocol === protocol)
          if (!protocolGroups.length && !protocolRows.length) return null
          return <section key={protocol} className="space-y-3" aria-labelledby={`provider-protocol-${protocol}`}><div className="flex items-center gap-2 px-1"><h2 id={`provider-protocol-${protocol}`} className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{protocol}</h2><span className="font-mono text-[10px] text-muted-foreground">{protocolRows.length} NODES</span></div>{protocolGroups.map((group) => renderGroup(protocol, group))}{protocolRows.some((provider) => provider.group_id === null) && renderGroup(protocol, null)}</section>
        })}
        {!hasAnyProvider && !providers.isLoading && !(providerGroups.data ?? []).length && <Card className="console-surface shadow-none"><CardContent className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground"><ServerOff className="h-8 w-8" /><p className="text-sm">还没有 Provider</p><Button variant="outline" size="sm" onClick={openCreate}><Plus className="h-4 w-4" /> 新增 Provider</Button></CardContent></Card>}
        {providers.isLoading && <Card className="console-surface shadow-none"><CardContent className="flex h-24 items-center justify-center text-sm text-muted-foreground">加载中...</CardContent></Card>}
      </div>

      <Dialog open={groupOpen} onOpenChange={(open) => { setGroupOpen(open); if (!open) setGroupDialogSource('page') }}><DialogContent><DialogHeader><DialogTitle>新建 Provider 分组</DialogTitle><DialogDescription>分组按协议隔离，只用于管理和列表展示，不参与代理路由。</DialogDescription></DialogHeader><div className="space-y-4 py-2"><div className="space-y-1.5"><Label>协议</Label><Select value={groupForm.protocol} onValueChange={(value) => setGroupForm({ ...groupForm, protocol: value as Protocol })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">openai</SelectItem><SelectItem value="anthropic">anthropic</SelectItem></SelectContent></Select></div><div className="space-y-1.5"><Label>分组名称</Label><Input value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} placeholder="生产环境" /></div></div><DialogFooter><Button variant="outline" onClick={() => setGroupOpen(false)}>取消</Button><Button disabled={!groupForm.name.trim() || createGroupMutation.isPending} onClick={() => createGroupMutation.mutate()}>{createGroupMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />} 创建</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}><DialogContent><DialogHeader><DialogTitle>重命名 Provider 分组</DialogTitle></DialogHeader><Input autoFocus value={renaming?.name ?? ''} onChange={(event) => renaming && setRenaming({ ...renaming, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && renaming?.name.trim()) renameGroupMutation.mutate({ protocol: renaming.protocol, group_id: renaming.id, name: renaming.name.trim() }) }} /><DialogFooter><Button variant="outline" onClick={() => setRenaming(null)}>取消</Button><Button disabled={!renaming?.name.trim() || renameGroupMutation.isPending} onClick={() => renaming && renameGroupMutation.mutate({ protocol: renaming.protocol, group_id: renaming.id, name: renaming.name.trim() })}>保存</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setApiKeyVisible(false) }}>
        <DialogContent className="grid max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-md p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-full">
          <DialogHeader className="border-b px-4 py-4 pr-12 text-left sm:px-6 sm:py-5">
            <DialogTitle>{formMode === 'edit' ? '编辑 Provider' : formMode === 'copy' ? '复制 Provider' : '新增 Provider'}</DialogTitle>
            <DialogDescription>API Key 会以明文存储在本机数据库中，请妥善保管。</DialogDescription>
          </DialogHeader>
          <div
            className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
            role="region"
            aria-label="Provider 配置"
            tabIndex={0}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label>名称</Label><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="如：OpenAI 官方" /></div><div className="space-y-1.5"><Label>协议</Label><Select disabled={formMode === 'edit'} value={form.protocol} onValueChange={(value) => setForm({ ...form, protocol: value as Protocol, group_id: value === form.protocol ? form.group_id : '' })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">openai</SelectItem><SelectItem value="anthropic">anthropic</SelectItem></SelectContent></Select></div></div>
            <div className="space-y-1.5"><Label>分组（可选）</Label><div className="flex gap-2"><Select value={form.group_id || 'none'} onValueChange={(value) => setForm({ ...form, group_id: value === 'none' ? '' : value })}><SelectTrigger className="flex-1"><SelectValue placeholder="未分组" /></SelectTrigger><SelectContent><SelectItem value="none">未分组</SelectItem>{(providerGroups.data ?? []).filter((group) => group.protocol === form.protocol).map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" size="icon" onClick={() => openGroupDialog(form.protocol, 'provider')} aria-label="新建 Provider 分组" title="新建 Provider 分组"><FolderPlus className="h-4 w-4" /></Button></div></div>
            <div className="space-y-1.5"><Label>Base URL</Label><Input value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} placeholder="https://api.openai.com" /><p className="text-xs text-muted-foreground">不含 /v1 后缀，网关会自动拼接</p></div>
            <div className="space-y-1.5"><Label>API Key</Label><div className="flex gap-2"><div className="relative min-w-0 flex-1"><Input className="pr-10" type={apiKeyVisible ? 'text' : 'password'} value={form.api_key} onChange={(event) => setForm({ ...form, api_key: event.target.value })} placeholder="sk-..." aria-label="API Key" /><Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2" onClick={() => setApiKeyVisible((visible) => !visible)} aria-label={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'} title={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'}>{apiKeyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</Button></div><Button type="button" variant="outline" className="shrink-0" onClick={decodeApiKey} title="Base64 解码并回填为明文"><Unlock className="h-3.5 w-3.5" /> 解码</Button></div><p className="text-xs text-muted-foreground">如粘贴的是 Base64 编码的 Key，点击「解码」直接转成明文</p></div>
            {form.protocol === 'anthropic' && <div className="space-y-1.5"><Label>Anthropic Version（可选）</Label><Input value={form.anthropic_version} onChange={(event) => setForm({ ...form, anthropic_version: event.target.value })} placeholder="2023-06-01（留空使用默认值）" /></div>}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label>代理 URL（可选）</Label><Input value={form.proxy_url} onChange={(event) => setForm({ ...form, proxy_url: event.target.value })} placeholder="http://127.0.0.1:7890" /></div><div className="space-y-1.5"><Label>超时毫秒</Label><Input value={form.timeout_ms} onChange={(event) => setForm({ ...form, timeout_ms: event.target.value })} placeholder="120000（0 表示不超时）" /></div></div>
            <div className="space-y-1.5"><Label>自定义请求头</Label><Textarea value={form.custom_headers} onChange={(event) => setForm({ ...form, custom_headers: event.target.value })} rows={3} className="font-mono text-xs" placeholder='{"X-Custom": "value"}' /><p className="text-xs text-muted-foreground">JSON 格式，不可覆盖 authorization / x-api-key / accept-encoding</p></div>
            <div className="space-y-1.5"><Label>模型过滤规则（可选）</Label><Input value={form.model_filter} onChange={(event) => setForm({ ...form, model_filter: event.target.value })} placeholder="grok-*,mimo-*" /><p className="text-xs text-muted-foreground">逗号分隔的前缀匹配规则，拉取时只入库匹配的模型。留空不过滤。例：gpt-*,claude-*</p></div>
          </div>
          <DialogFooter className="gap-2 border-t bg-background px-4 py-3 sm:space-x-0 sm:px-6"><Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button><Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !form.name.trim() || !form.base_url.trim()}>{saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{formMode === 'edit' ? '保存修改' : formMode === 'copy' ? '创建副本' : '创建'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!fetchDialog} onOpenChange={(open) => { if (!open) setFetchDialog(null) }}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>选择要导入的模型</DialogTitle><DialogDescription>{fetchDialog ? `从「${fetchDialog.providerName}」拉取到 ${upstreamModels.length} 个模型` : ''}</DialogDescription></DialogHeader>
        {upstreamLoading ? <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 正在拉取模型列表...</div> : <div className="space-y-3"><div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8 text-sm" placeholder="搜索模型..." value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} /></div><div className="flex items-center justify-between text-xs text-muted-foreground"><span>已选 {selectedModels.size} / {upstreamModels.length}</span><div className="flex gap-2"><button className="hover:underline" onClick={() => setSelectedModels(new Set(upstreamModels))}>全选</button><button className="hover:underline" onClick={() => setSelectedModels(new Set())}>全不选</button></div></div><div className="h-64 space-y-0.5 overflow-y-auto rounded-md border p-2">{filteredUpstream.map((id) => <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"><input type="checkbox" checked={selectedModels.has(id)} onChange={(event) => { const next = new Set(selectedModels); if (event.target.checked) next.add(id); else next.delete(id); setSelectedModels(next) }} className="h-3.5 w-3.5" /><span className="font-mono text-xs">{id}</span></label>)}{!filteredUpstream.length && <p className="py-4 text-center text-sm text-muted-foreground">{upstreamModels.length === 0 ? '未获取到模型' : '无匹配模型'}</p>}</div></div>}
        <DialogFooter><Button variant="outline" onClick={() => setFetchDialog(null)}>取消</Button><Button disabled={selectedModels.size === 0 || importModelsMutation.isPending} onClick={() => fetchDialog && importModelsMutation.mutate({ providerId: fetchDialog.providerId, modelIds: [...selectedModels] })}>{importModelsMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />} 导入 {selectedModels.size} 个模型</Button></DialogFooter>
      </DialogContent></Dialog>
    </div>
    </>
  )
}
