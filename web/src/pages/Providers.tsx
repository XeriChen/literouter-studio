import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  Copy,
  ExternalLink,
  FolderPlus,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  ServerOff,
  Trash2,
  Wifi,
  X,
} from 'lucide-react'
import { api } from '@/api/client'
import type { Provider, ProviderGroup, ProviderModel, BalanceResult } from '@/api/types'
import { useBottomInset } from '@/hooks/useBottomInset'
import { useTimedNotice } from '@/hooks/useTimedNotice'
import { useConfirm } from '@/components/ConfirmDialog'
import {
  EMPTY_FORM,
  ProviderFormDialog,
  formFromProvider,
  type FormMode,
  type ProviderForm,
  type Protocol,
} from '@/components/providers/ProviderFormDialog'
import { ImportModelsDialog } from '@/components/providers/ImportModelsDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const PROTOCOLS: Protocol[] = ['openai', 'anthropic']

export default function Providers() {
  const qc = useQueryClient()
  const chromeInset = useBottomInset()
  const { confirm, confirmDialog } = useConfirm()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [formMode, setFormMode] = useState<FormMode>('create')
  const [editing, setEditing] = useState<Provider | null>(null)
  const [form, setForm] = useState<ProviderForm>({ ...EMPTY_FORM })
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [result, setResultState] = useState<{ id: number; message: string; ok: boolean } | null>(null)
  const resultSeq = useRef(0)
  function setResult(next: { message: string; ok: boolean } | null) {
    setResultState(next ? { id: ++resultSeq.current, message: next.message, ok: next.ok } : null)
  }
  const { leaving: resultLeaving, fadeMs: resultFadeMs, requestLeave: dismissResult } = useTimedNotice(
    result ? String(result.id) : null,
    () => setResultState(null),
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupForm, setGroupForm] = useState<{ protocol: Protocol; name: string }>({ protocol: 'openai', name: '' })
  const [groupDialogSource, setGroupDialogSource] = useState<'page' | 'provider'>('page')
  const [renaming, setRenaming] = useState<{ protocol: Protocol; id: string; name: string } | null>(null)
  const [selectedProviderIds, setSelectedProviderIds] = useState<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState<Set<string>>(new Set())
  const [fetchDialog, setFetchDialog] = useState<{ providerId: string; providerName: string } | null>(null)
  const [upstreamModels, setUpstreamModels] = useState<string[]>([])
  const [upstreamLoading, setUpstreamLoading] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [modelSearch, setModelSearch] = useState('')
  const [createAlias, setCreateAlias] = useState(true)

  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('/api/providers') })
  const providerGroups = useQuery({ queryKey: ['provider-groups'], queryFn: () => api<ProviderGroup[]>('/api/provider-groups') })
  // 导入弹窗打开时才加载真实模型，用于在拉取列表中标记「已导入 / 已添加」状态
  const importedModels = useQuery({ queryKey: ['models'], queryFn: () => api<ProviderModel[]>('/api/models'), enabled: !!fetchDialog })
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
      const auth: Record<string, string | { header_name: string; format: string }> = {}
      if (form.api_key) auth.api_key = form.api_key
      if (form.access_token.trim()) auth.access_token = form.access_token.trim()
      if (form.protocol === 'anthropic' && form.anthropic_version.trim()) auth.version = form.anthropic_version.trim()
      if (form.custom_auth_header_name.trim() && form.custom_auth_format.trim()) {
        auth.custom_auth = {
          header_name: form.custom_auth_header_name.trim(),
          format: form.custom_auth_format.trim(),
        }
      }
      let custom_headers: Record<string, string>
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
        upstream_type: form.upstream_type || null,
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
      const results = await Promise.allSettled(providerIds.map((id) => api(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) })))
      const failed = results.filter((r) => r.status === 'rejected').length
      return { total: providerIds.length, failed, enabled }
    },
    onSuccess: ({ total, failed, enabled }) => {
      setSelectedProviderIds(new Set()); setSelectionMode(new Set())
      invalidateProviderData()
      const action = enabled ? '批量启用' : '批量禁用'
      setResult({ message: failed === 0 ? `${action}完成` : `${action}完成：成功 ${total - failed}，失败 ${failed}`, ok: failed === 0 })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '批量更新失败', ok: false }),
  })

  const batchDeleteMutation = useMutation({
    mutationFn: async (providerIds: string[]) => {
      const results = await Promise.allSettled(providerIds.map((id) => api(`/api/providers/${id}`, { method: 'DELETE' })))
      const failed = results.filter((r) => r.status === 'rejected').length
      return { total: providerIds.length, failed }
    },
    onSuccess: ({ total, failed }) => {
      setSelectedProviderIds(new Set()); setSelectionMode(new Set())
      invalidateProviderData()
      setResult({ message: failed === 0 ? '批量删除完成' : `批量删除完成：成功 ${total - failed}，失败 ${failed}`, ok: failed === 0 })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '批量删除失败', ok: false }),
  })

  const batchMoveMutation = useMutation({
    mutationFn: async ({ providerIds, groupId }: { providerIds: string[]; groupId: string | null }) => {
      const results = await Promise.allSettled(providerIds.map((id) => api(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify({ group_id: groupId }) })))
      const failed = results.filter((r) => r.status === 'rejected').length
      return { total: providerIds.length, failed }
    },
    onSuccess: ({ total, failed }) => {
      setSelectedProviderIds(new Set()); setSelectionMode(new Set())
      invalidateProviderData()
      setResult({ message: failed === 0 ? '批量移动分组完成' : `批量移动完成：成功 ${total - failed}，失败 ${failed}`, ok: failed === 0 })
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

  const balanceMutation = useMutation({
    mutationFn: (id: string) => api<BalanceResult>(`/api/providers/${id}/balance`, { method: 'GET' }),
    onSuccess: (data) => {
      if (!data.success) {
        setResult({ message: `余额查询失败：${data.error ?? '未知错误'}`, ok: false })
        return
      }
      const expiry = data.expires_at
        ? `，到期日 ${new Date(data.expires_at).toLocaleDateString()}`
        : ''
      if (data.unlimited) {
        const used = data.balances.find((item) => item.label === '已用' || item.label === '令牌已用')
        const user = data.balances.find((item) => item.label === '用户余额')
        const parts: string[] = []
        if (user) parts.push(`用户余额 ${user.balance.toFixed(2)} ${user.currency}`)
        parts.push(used ? `无限额，已用 ${used.balance.toFixed(2)} ${used.currency}` : '无限额（上游未返回用量）')
        setResult({ message: `余额：${parts.join('；')}${expiry}`, ok: true })
        return
      }
      if (data.balance === null) {
        setResult({ message: `余额查询失败：${data.error ?? '未知错误'}`, ok: false })
        return
      }
      const detail = data.balances.length > 1
        ? data.balances.map((item) => `${item.label} ${item.balance.toFixed(2)} ${item.currency}`).join('，')
        : `${data.balance.toFixed(2)} ${data.currency ?? ''}`
      setResult({ message: `余额：${detail}${expiry}${data.available === false ? '（额度不足或已停用）' : ''}`, ok: true })
    },
    onError: (error) => setResult({ message: error instanceof Error ? error.message : '余额查询失败', ok: false }),
  })

  async function openFetchDialog(id: string, name: string) {
    setFetchDialog({ providerId: id, providerName: name })
    setUpstreamModels([])
    setSelectedModels(new Set())
    setModelSearch('')
    setCreateAlias(true)
    setUpstreamLoading(true)
    try {
      const data = await api<{ model_ids: string[] }>(`/api/providers/${id}/upstream-models`, { method: 'POST' })
      setUpstreamModels(data.model_ids)
    } catch (error) {
      setResult({ message: `拉取失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false })
      setFetchDialog(null)
    } finally {
      setUpstreamLoading(false)
    }
  }

  const importModelsMutation = useMutation({
    mutationFn: ({ providerId, modelIds, createAlias: withAlias }: { providerId: string; modelIds: string[]; createAlias: boolean }) => api<{ added: number; updated: number }>(`/api/providers/${providerId}/import-models`, { method: 'POST', body: JSON.stringify({ model_ids: modelIds, create_alias: withAlias }) }),
    onSuccess: (data) => {
      setResult({ message: `导入成功：新增 ${data.added}，刷新 ${data.updated}`, ok: true })
      setFetchDialog(null)
      invalidateProviderData()
    },
    onError: (error) => setResult({ message: `导入失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false }),
  })

  /** 取消导入：删除该 Provider 下的单个拉取导入模型（同名映射保留并随引用修复，可重新导入）。 */
  const cancelImportMutation = useMutation({
    mutationFn: (input: { providerId: string; modelId: string }) =>
      api('/api/models', { method: 'DELETE', body: JSON.stringify({ provider_id: input.providerId, model_id: input.modelId }) }),
    onSuccess: (_data, { modelId }) => {
      setSelectedModels((current) => { const next = new Set(current); next.delete(modelId); return next })
      invalidateProviderData()
      setResult({ message: `已取消导入 ${modelId}`, ok: true })
    },
    onError: (error) => setResult({ message: `取消导入失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false }),
  })

  /** 一键清理：删除该 Provider 全部拉取导入的模型（source='fetched'），手动添加的模型不受影响。 */
  const cleanupImportedMutation = useMutation({
    mutationFn: ({ providerId }: { providerId: string }) => api<{ deleted: number }>(`/api/providers/${providerId}/cleanup-imported-models`, { method: 'POST' }),
    onSuccess: (data) => {
      const cleaned = new Set(importedFetchedIds)
      setSelectedModels((current) => new Set([...current].filter((id) => !cleaned.has(id))))
      invalidateProviderData()
      setResult({ message: `一键清理完成：已删除 ${data.deleted} 个导入模型（手动添加的模型不受影响）`, ok: true })
    },
    onError: (error) => setResult({ message: `一键清理失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false }),
  })

  const filteredUpstream = useMemo(() => {
    if (!modelSearch.trim()) return upstreamModels
    const query = modelSearch.trim().toLowerCase()
    return upstreamModels.filter((id) => id.toLowerCase().includes(query))
  }, [upstreamModels, modelSearch])

  /** 该 Provider 已入库的模型（model_id → 记录）：source='fetched' 为拉取导入，'manual' 为手动添加 */
  const importedById = useMemo(() => {
    const map = new Map<string, ProviderModel>()
    if (!fetchDialog) return map
    for (const model of importedModels.data ?? []) {
      if (model.provider_id === fetchDialog.providerId) map.set(model.model_id, model)
    }
    return map
  }, [importedModels.data, fetchDialog])
  /** 清理会删除的模型：该 Provider 全部 source='fetched'（可能含已不在上游列表里的旧导入） */
  const importedFetchedIds = useMemo(
    () => [...importedById.values()].filter((model) => model.source === 'fetched').map((model) => model.model_id),
    [importedById],
  )

  function toggleUpstreamModel(id: string) {
    setSelectedModels((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

  function renderProviderTable(rows: Provider[], groupKey: string) {
    const isActive = selectionMode.has(groupKey)
    const allSelected = rows.length > 0 && rows.every((provider) => selectedProviderIds.has(provider.id))
    const someSelected = rows.some((provider) => selectedProviderIds.has(provider.id))
    const cols = isActive ? 6 : 5
    return (
      <Table className="data-table">
        <TableHeader><TableRow>
          {isActive && <TableHead className="w-10 pl-4"><Checkbox checked={allSelected ? true : someSelected ? 'indeterminate' : false} onCheckedChange={() => toggleRowsSelection(rows)} aria-label="选择当前分组全部 Provider" /></TableHead>}
          <TableHead>名称</TableHead><TableHead>协议</TableHead><TableHead>Base URL</TableHead><TableHead>状态</TableHead><TableHead className="pr-6 text-right">操作</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((provider) => (
            <TableRow key={provider.id} className={selectedProviderIds.has(provider.id) ? 'bg-muted/50' : undefined}>
              {isActive && <TableCell className="pl-4"><Checkbox checked={selectedProviderIds.has(provider.id)} onCheckedChange={() => toggleProviderSelection(provider.id)} aria-label={`选择 ${provider.name}`} /></TableCell>}
              <TableCell className="font-medium">{provider.name}</TableCell>
              <TableCell><Badge variant={provider.protocol === 'openai' ? 'outline' : 'secondary'}>{provider.protocol}</Badge></TableCell>
              <TableCell className="max-w-[240px]"><a href={provider.base_url.startsWith('http://') || provider.base_url.startsWith('https://') ? provider.base_url : `https://${provider.base_url}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 truncate font-mono text-xs text-foreground underline-offset-2 hover:underline" title={provider.base_url}><ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" /><span className="truncate">{provider.base_url}</span></a></TableCell>
              <TableCell><Switch checked={!!provider.enabled} disabled={toggleMutation.isPending && toggleMutation.variables?.id === provider.id} onCheckedChange={() => toggleMutation.mutate(provider)} aria-label={`切换 ${provider.name} 启用状态`} /></TableCell>
              <TableCell className="pr-6"><div className="flex items-center justify-end gap-1">
                {(provider.upstream_type === 'newapi' || provider.upstream_type === 'sub2api') && <Button variant="ghost" size="icon" className="icon-button" aria-label={`查询 ${provider.name} 余额`} title="查询余额" onClick={() => balanceMutation.mutate(provider.id)} disabled={balanceMutation.isPending}><CircleDollarSign className="h-3.5 w-3.5" /></Button>}
                <Button variant="ghost" size="icon" className="icon-button" aria-label={`测试 ${provider.name}`} title="测试连通性" onClick={() => testMutation.mutate(provider.id)} disabled={testMutation.isPending}><Wifi className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="icon-button" aria-label={`拉取 ${provider.name} 的模型`} title="拉取模型" onClick={() => openFetchDialog(provider.id, provider.name)}><RefreshCw className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="icon-button" aria-label={`复制 ${provider.name}`} title="复制 Provider" onClick={() => openCopy(provider)}><Copy className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="icon-button" aria-label={`编辑 ${provider.name}`} title="编辑" onClick={() => openEdit(provider)}><Pencil className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" className="icon-button hover:text-destructive" aria-label={`删除 ${provider.name}`} title="删除" onClick={() => { void (async () => { if (await confirm({ title: '删除 Provider？', description: `确定删除 Provider「${provider.name}」？关联的模型也会一并删除。`, confirmLabel: '删除', destructive: true })) deleteMutation.mutate(provider.id) })() }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div></TableCell>
            </TableRow>
          ))}
          {!rows.length && <TableRow><TableCell colSpan={cols} className="h-16 text-center text-xs text-muted-foreground">暂无 Provider，可从右上角新增。</TableCell></TableRow>}
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
    const isActive = selectionMode.has(key)
    return (
      <Card key={key} className="console-surface shadow-none">
        <CardHeader className="items-stretch justify-between gap-2 space-y-0 border-b border-foreground/10 px-5 py-3 sm:flex-row sm:items-center">
          <button className="flex min-w-0 flex-wrap items-center gap-2 text-left" onClick={() => toggleGroup(key)} aria-expanded={isOpen}>
            {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <CardTitle className="truncate text-sm font-medium">{group?.name ?? '未分组'}</CardTitle>
            <Badge variant="outline">{protocol}</Badge>
            <Badge
              variant="secondary"
              className="shrink-0 font-mono whitespace-nowrap"
              title={group ? `已启用 ${enabledCount} / 共 ${rows.length}` : `共 ${rows.length} 个 Provider`}
            >
              {group ? `${enabledCount}/${rows.length}` : rows.length}
            </Badge>
          </button>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button
              size="icon"
              variant={isActive ? 'secondary' : 'ghost'}
              className="h-8 w-8"
              aria-label={`切换 ${group?.name ?? '未分组'} 多选模式`}
              title={`切换 ${group?.name ?? '未分组'} 多选模式`}
              onClick={() => {
                if (selectionMode.has(key)) {
                  setSelectionMode((prev) => { const next = new Set(prev); next.delete(key); return next })
                  setSelectedProviderIds((prev) => { const next = new Set(prev); rows.forEach((provider) => next.delete(provider.id)); return next })
                } else {
                  setSelectionMode((prev) => new Set(prev).add(key))
                }
              }}
            >
              <ListChecks className="h-4 w-4" />
            </Button>
            {group && <>
              <div
                className="flex items-center px-1"
                title={groupSwitchChecked ? '全部已启用（点击禁用组内全部 Provider）' : enabledCount > 0 ? `部分已启用 ${enabledCount}/${rows.length}（点击启用组内全部 Provider）` : '全部已禁用（点击启用组内全部 Provider）'}
              >
                <Switch
                  checked={groupSwitchChecked}
                  disabled={!rows.length || groupActionMutation.isPending}
                  onCheckedChange={(enabled) => groupActionMutation.mutate({ action: 'toggle-enabled', group, enabled: enabled ? 1 : 0 })}
                  aria-label={`切换 ${group.name} 内全部 Provider 启用状态（当前 ${enabledCount}/${rows.length}）`}
                  title={groupSwitchChecked ? '禁用组内全部 Provider' : '启用组内全部 Provider'}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={!rows.length || groupActionMutation.isPending}
                aria-label={`清空分组 ${group.name} 内的 Provider`}
                title="清空 Provider（不删分组）"
                onClick={async () => {
                  if (await confirm({ title: '清空分组？', description: `确定删除分组「${group.name}」内的 ${rows.length} 个 Provider？关联的模型和映射候选也会一并删除。`, confirmLabel: '清空', destructive: true })) {
                    groupActionMutation.mutate({ action: 'clear', group })
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={`重命名分组 ${group.name}`}
                title="重命名分组"
                onClick={() => setRenaming({ protocol: group.protocol, id: group.id, name: group.name })}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:text-destructive"
                aria-label={`删除分组 ${group.name}`}
                title="删除分组"
                onClick={async () => {
                  if (await confirm({ title: '删除分组？', description: `删除分组「${group.name}」？组内 Provider 会移到未分组，不会删除。`, confirmLabel: '删除分组', destructive: true })) {
                    groupActionMutation.mutate({ action: 'delete', group })
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>}
          </div>
        </CardHeader>
        {isOpen && <CardContent className="p-0">{renderProviderTable(rows, key)}</CardContent>}
      </Card>
    )
  }

  const hasAnyProvider = (providers.data?.length ?? 0) > 0
  const resultNotice = result ? (
    <div role="status" className={`notice border border-white/[0.14] px-3.5 py-2.5 ${result.ok ? 'notice-success' : 'notice-error'}${resultLeaving ? ' is-leaving' : ''}`} style={resultLeaving ? { animationDuration: `${resultFadeMs}ms` } : undefined}>
      {result.ok
        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{result.message}</span>
      <button type="button" aria-label="关闭提示" onClick={dismissResult} className="icon-button h-6 w-6"><X className="h-3.5 w-3.5" /></button>
    </div>
  ) : null

  return (
    <>
    {confirmDialog}
    {/* 非编辑弹窗时通知统一 portal 到 body：.page-shell 带 animate-rise-in 残留 transform，
        会让内部 fixed 相对页面而非视口定位；portal 后始终浮在视口顶部，滚动不跟随 */}
    {result && !dialogOpen && createPortal(
      <div className="notice-layer px-4">{resultNotice}</div>,
      document.body,
    )}
    {/* 批量操作条：portal 到 body，与 NoticeStack 一致，避免 page-shell 动画 transform 影响 fixed 定位 */}
    {selectedProviderIds.size > 0 && createPortal(<div style={{ bottom: `calc(${chromeInset}px + 1rem)` }} className="fixed inset-x-3 z-[90] mx-auto flex max-w-fit flex-wrap items-center justify-center gap-2 rounded-lg border bg-card px-3 py-2.5 shadow-xl sm:gap-3 sm:px-5 sm:py-3">
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
      <Button size="sm" variant="outline" onClick={() => { void (async () => { if (await confirm({ title: '删除选中 Provider？', description: `确定删除选中的 ${selectedProviderIds.size} 个 Provider？关联的模型也会一并删除。`, confirmLabel: '删除', destructive: true })) batchDeleteMutation.mutate([...selectedProviderIds]) })() }} disabled={batchSetEnabledMutation.isPending || batchMoveMutation.isPending || batchDeleteMutation.isPending}><Trash2 className="h-3.5 w-3.5" /> 删除</Button>
      <Button size="sm" variant="ghost" onClick={() => { setSelectedProviderIds(new Set()); setSelectionMode(new Set()) }} aria-label="清除 Provider 选择"><X className="h-3.5 w-3.5" /></Button>
    </div>, document.body)}
    <div className="page-shell space-y-6">
      <div className="page-heading">
        <div><div className="eyebrow mb-2 flex items-center gap-2"><Wifi className="h-3.5 w-3.5" /> 上游连接</div><h1 className="page-title">Providers</h1><p className="page-description">按协议和自定义分组管理 LLM 服务接入点、连通性与模型发现。</p></div>
        <div className="flex flex-wrap items-center gap-2"><Button variant="outline" onClick={() => openGroupDialog()} size="sm"><FolderPlus className="h-4 w-4" /> 新建分组</Button><Button onClick={openCreate} size="sm"><Plus className="h-4 w-4" /> 新增 Provider</Button></div>
      </div>

      <div className="space-y-4">
        {providers.isError && (
          <div className="notice notice-error border border-white/[0.14] px-3.5 py-2.5">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>加载 Provider 失败：{providers.error instanceof Error ? providers.error.message : 'unknown'}</span>
            <button type="button" className="ml-auto shrink-0 font-semibold underline underline-offset-4" onClick={() => providers.refetch()}>重试</button>
          </div>
        )}
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

      <ProviderFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        formMode={formMode}
        form={form}
        onFormChange={setForm}
        apiKeyVisible={apiKeyVisible}
        onApiKeyVisibleChange={setApiKeyVisible}
        resultNotice={resultNotice}
        providerGroups={providerGroups.data ?? []}
        onOpenGroupDialog={openGroupDialog}
        decodeApiKey={decodeApiKey}
        savePending={saveMutation.isPending}
        onSave={() => saveMutation.mutate()}
      />

      <ImportModelsDialog
        fetchDialog={fetchDialog}
        onFetchDialogChange={setFetchDialog}
        upstreamModels={upstreamModels}
        upstreamLoading={upstreamLoading}
        selectedModels={selectedModels}
        onSelectedModelsChange={setSelectedModels}
        modelSearch={modelSearch}
        onModelSearchChange={setModelSearch}
        createAlias={createAlias}
        onCreateAliasChange={setCreateAlias}
        filteredUpstream={filteredUpstream}
        importedById={importedById}
        importedFetchedIds={importedFetchedIds}
        toggleUpstreamModel={toggleUpstreamModel}
        confirm={confirm}
        cleanupPending={cleanupImportedMutation.isPending}
        onCleanup={(providerId) => cleanupImportedMutation.mutate({ providerId })}
        cancelPending={cancelImportMutation.isPending}
        onCancelImport={(input) => cancelImportMutation.mutate(input)}
        importPending={importModelsMutation.isPending}
        onImport={(input) => importModelsMutation.mutate(input)}
      />
    </div>
    </>
  )
}
