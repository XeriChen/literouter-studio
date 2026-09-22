import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Box, ChevronDown, ChevronRight, ListChecks, Loader2, Plus, Search, Trash2, X } from 'lucide-react'
import { api } from '@/api/client'
import type { Provider, ProviderModel } from '@/api/types'
import { useBottomInset } from '@/hooks/useBottomInset'
import { useTimedToasts } from '@/hooks/useTimedNotice'
import { useConfirm } from '@/components/ConfirmDialog'
import { NoticeStack } from '@/components/NoticeStack'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import ModelAliases from './ModelAliases'

export default function Models() {
  const [tab, setTab] = useState<'aliases' | 'real'>('aliases')

  return (
    <div className="page-shell space-y-4">
      <Tabs value={tab} onValueChange={(value) => setTab(value as 'aliases' | 'real')}>
        <TabsList>
          <TabsTrigger value="aliases">模型映射</TabsTrigger>
          <TabsTrigger value="real">真实模型</TabsTrigger>
        </TabsList>
        <TabsContent value="aliases" className="mt-4"><ModelAliases /></TabsContent>
        <TabsContent value="real" className="mt-4"><RealModelsList /></TabsContent>
      </Tabs>
    </div>
  )
}

function RealModelsList() {
  const qc = useQueryClient()
  const chromeInset = useBottomInset()
  const { confirm, confirmDialog } = useConfirm()
  const [protocol, setProtocol] = useState<'all' | 'openai' | 'anthropic'>('all')
  const [providerId, setProviderId] = useState('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ provider_id: '', model_id: '', display_name: '' })
  const [testTarget, setTestTarget] = useState<ProviderModel | null>(null)
  const [testPrompt, setTestPrompt] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testLatency, setTestLatency] = useState<number | null>(null)
  const [quickTestId, setQuickTestId] = useState<string | null>(null)
  const toasts = useTimedToasts<{ ok: boolean; message: string; latency_ms: number }>()
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function addToast(ok: boolean, message: string, latency_ms: number) {
    toasts.push({ ok, message, latency_ms })
  }

  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<ProviderModel[]>('/api/models'),
  })
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<Provider[]>('/api/providers'),
  })

  const filtered = useMemo(() => {
    let rows = models.data ?? []
    // Provider 禁用后其模型不可见（调用侧 503/列表侧隐藏一致）
    rows = rows.filter((m) => m.provider_enabled === 1)
    if (protocol !== 'all') rows = rows.filter((m) => m.protocol === protocol)
    if (providerId !== 'all') rows = rows.filter((m) => m.provider_id === providerId)
    if (onlyEnabled) rows = rows.filter((m) => m.enabled)
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim().toLowerCase()
      rows = rows.filter((m) =>
        m.model_id.toLowerCase().includes(q) ||
        (m.display_name ?? '').toLowerCase().includes(q) ||
        m.provider_name.toLowerCase().includes(q)
      )
    }
    return rows
  }, [models.data, protocol, providerId, onlyEnabled, debouncedSearch])

  const toggleMutation = useMutation({
    mutationFn: (m: ProviderModel) =>
      api(`/api/models`, {
        method: 'PATCH',
        body: JSON.stringify({ provider_id: m.provider_id, model_id: m.model_id, enabled: m.enabled ? 0 : 1 }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['models'] }); qc.invalidateQueries({ queryKey: ['aliases'] }) },
  })

  const addMutation = useMutation({
    mutationFn: () =>
      api('/api/models', {
        method: 'POST',
        body: JSON.stringify({ provider_id: addForm.provider_id, model_id: addForm.model_id, display_name: addForm.display_name || null }),
      }),
    onSuccess: () => {
      setAddOpen(false)
      setAddForm({ provider_id: '', model_id: '', display_name: '' })
      qc.invalidateQueries({ queryKey: ['models'] })
      qc.invalidateQueries({ queryKey: ['aliases'] })
    },
  })

  const delMutation = useMutation({
    mutationFn: (m: ProviderModel) =>
      api('/api/models', { method: 'DELETE', body: JSON.stringify({ provider_id: m.provider_id, model_id: m.model_id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
  })

  function modelKey(m: ProviderModel) {
    return `${m.provider_id}/${m.model_id}`
  }

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectAll() {
    if (filtered.length > 0 && selectedModels.length === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map((m) => modelKey(m))))
  }

  const batchDeleteMutation = useMutation({
    mutationFn: async (items: ProviderModel[]) => {
      await Promise.all(items.map((m) =>
        api('/api/models', { method: 'DELETE', body: JSON.stringify({ provider_id: m.provider_id, model_id: m.model_id }) })
      ))
    },
    onSuccess: () => {
      setSelected(new Set()); setSelectionMode(false)
      qc.invalidateQueries({ queryKey: ['models'] })
      qc.invalidateQueries({ queryKey: ['aliases'] })
      addToast(true, '批量删除完成', 0)
    },
  })

  const batchSetEnabledMutation = useMutation({
    mutationFn: async ({ items, enabled }: { items: ProviderModel[]; enabled: number }) => {
      await Promise.all(items.map((m) =>
        api('/api/models', {
          method: 'PATCH',
          body: JSON.stringify({ provider_id: m.provider_id, model_id: m.model_id, enabled }),
        })
      ))
    },
    onSuccess: (_data, { enabled }) => {
      setSelected(new Set()); setSelectionMode(false)
      qc.invalidateQueries({ queryKey: ['models'] })
      qc.invalidateQueries({ queryKey: ['aliases'] })
      addToast(true, enabled ? '批量启用完成' : '批量禁用完成', 0)
    },
  })

  const selectedModels = useMemo(() => {
    return filtered.filter((m) => selected.has(modelKey(m)))
  }, [filtered, selected])
  const allFilteredSelected = filtered.length > 0 && selectedModels.length === filtered.length

  // 分组默认折叠；搜索或筛选到具体 Provider 时自动展开，避免"筛了却看不见"
  const forceExpand = debouncedSearch.trim().length > 0 || providerId !== 'all'

  const modelGroups = useMemo(() => {
    const byProvider = new Map<string, ProviderModel[]>()
    for (const row of filtered) {
      const list = byProvider.get(row.provider_id) ?? []
      list.push(row)
      byProvider.set(row.provider_id, list)
    }
    const order = new Map((providers.data ?? []).map((p, index) => [p.id, index]))
    return [...byProvider.entries()]
      .sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
      .map(([pid, rows]) => ({ provider: (providers.data ?? []).find((p) => p.id === pid), rows }))
  }, [filtered, providers.data])

  const runTest = useMutation({
    mutationFn: ({ model, prompt }: { model: ProviderModel; prompt: string }) =>
      api<{ reply: string; latency_ms: number }>('/api/models/test', {
        method: 'POST',
        body: JSON.stringify({ provider_id: model.provider_id, model_id: model.model_id, prompt }),
      }),
  })

  function doTest(model: ProviderModel, prompt: string) {
    setTestResult(null)
    setTestLatency(null)
    runTest.mutate(
      { model, prompt },
      {
        onSuccess: (data) => {
          setTestResult(data.reply)
          setTestLatency(data.latency_ms)
        },
        onError: (err) => setTestResult(`测试失败：${err instanceof Error ? err.message : 'unknown'}`),
      },
    )
  }

  function toggleRows(keys: string[]) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (keys.every((key) => next.has(key))) keys.forEach((key) => next.delete(key))
      else keys.forEach((key) => next.add(key))
      return next
    })
  }

  function renderModelTable(rows: ProviderModel[]) {
    return (
      <Table className="data-table">
        <TableHeader>
          <TableRow>
            {selectionMode && <TableHead className="w-10 pl-4"><span className="sr-only">选择</span></TableHead>}
            <TableHead>Model</TableHead>
            <TableHead>来源</TableHead>
            <TableHead>启用</TableHead>
            <TableHead>测活</TableHead>
            <TableHead className="pr-6 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((m) => {
            const rowKey = modelKey(m)
            return (
              <TableRow key={rowKey} className={selected.has(rowKey) ? 'bg-muted/50' : ''}>
                {selectionMode && <TableCell className="pl-4">
                  <Checkbox checked={selected.has(rowKey)} onCheckedChange={() => toggleSelect(rowKey)} aria-label={`选择 ${m.model_id}`} />
                </TableCell>}
                <TableCell className="max-w-[220px] truncate font-mono text-xs">{m.model_id}</TableCell>
                <TableCell><Badge variant="secondary">{m.source}</Badge></TableCell>
                <TableCell>
                  <Switch
                    checked={!!m.enabled}
                    disabled={!m.provider_enabled}
                    onCheckedChange={() => toggleMutation.mutate(m)}
                    aria-label={`切换 ${m.model_id} 启用状态`}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" aria-label={`测活 ${m.model_id}`} title="测活" onClick={() => { setTestTarget(m); setTestPrompt(''); setTestResult(null); setTestLatency(null) }}>
                      <Activity className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" disabled={quickTestId === rowKey}
                      onClick={() => {
                        setQuickTestId(rowKey)
                        runTest.mutate(
                          { model: m, prompt: '请用一句话介绍你自己' },
                          {
                            onSuccess: (data) => addToast(true, `${m.model_id}: ${data.reply}`, data.latency_ms),
                            onError: (err) => addToast(false, `${m.model_id}: ${err instanceof Error ? err.message : '测试失败'}`, 0),
                            onSettled: () => setQuickTestId(null),
                          },
                        )
                      }}>
                      {quickTestId === rowKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '快速测试'}
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="pr-6">
                  <div className="flex justify-end">
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" aria-label={`删除 ${m.model_id}`} title="删除" onClick={async () => {
                      if (await confirm({
                        title: '删除模型？',
                        description: `确定删除模型「${m.model_id}」？同名映射候选会一并修复。`,
                        confirmLabel: '删除',
                        destructive: true,
                      })) delMutation.mutate(m)
                    }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    )
  }

  function renderProviderGroup(entry: { provider: Provider | undefined; rows: ProviderModel[] }) {
    const { provider, rows } = entry
    const pid = rows[0]?.provider_id ?? provider?.id ?? ''
    const isOpen = forceExpand || expandedProviders.has(pid)
    const name = provider?.name ?? pid
    const keys = rows.map((m) => modelKey(m))
    const selectedCount = keys.filter((key) => selected.has(key)).length
    const allSelected = rows.length > 0 && selectedCount === rows.length
    const enabledCount = rows.filter((m) => m.enabled).length
    return (
      <Card key={pid} className="console-surface shadow-none">
        <CardHeader className="items-stretch justify-between gap-2 space-y-0 border-b border-foreground/10 px-5 py-3 sm:flex-row sm:items-center">
          <button className="flex min-w-0 flex-wrap items-center gap-2 text-left" onClick={() => setExpandedProviders((prev) => { const next = new Set(prev); if (next.has(pid)) next.delete(pid); else next.add(pid); return next })} aria-expanded={isOpen}>
            {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <CardTitle className="truncate text-sm font-medium">{name}</CardTitle>
            <Badge variant={provider?.protocol === 'openai' ? 'outline' : 'secondary'}>{provider?.protocol}</Badge>
            <Badge
              variant="secondary"
              className="shrink-0 font-mono whitespace-nowrap"
              title={`已启用 ${enabledCount} / 共 ${rows.length}`}
            >
              {enabledCount}/{rows.length}
            </Badge>
          </button>
          {selectionMode && (
            <div
              className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
              title="全选本组"
            >
              <Checkbox
                checked={allSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
                onCheckedChange={() => toggleRows(keys)}
                aria-label={`选择 ${name} 的全部模型`}
                title="全选本组"
              />
            </div>
          )}
        </CardHeader>
        {isOpen && <CardContent className="p-0">{renderModelTable(rows)}</CardContent>}
      </Card>
    )
  }

  return (
    <>
    {confirmDialog}
    {/* Batch action bar */}
    {selectedModels.length > 0 && (
      <div style={{ bottom: `calc(${chromeInset}px + 1rem)` }} className="fixed inset-x-3 z-[90] mx-auto flex max-w-fit flex-wrap items-center justify-center gap-2 rounded-lg border bg-card px-3 py-2.5 shadow-xl sm:gap-3 sm:px-5 sm:py-3">
        <span className="text-sm font-medium">已选 {selectedModels.length} 个模型</span>
        <div className="hidden h-4 w-px bg-border sm:block" />
        <Button size="sm" variant="outline" onClick={() => batchSetEnabledMutation.mutate({ items: selectedModels, enabled: 1 })}>
          启用
        </Button>
        <Button size="sm" variant="outline" onClick={() => batchSetEnabledMutation.mutate({ items: selectedModels, enabled: 0 })}>
          禁用
        </Button>
        <Button size="sm" variant="outline" onClick={async () => {
          if (await confirm({
            title: '删除选中模型？',
            description: `确定删除选中的 ${selectedModels.length} 个模型？关联的映射候选会一并修复。`,
            confirmLabel: '删除',
            destructive: true,
          })) batchDeleteMutation.mutate(selectedModels)
        }}>
          <Trash2 className="h-3.5 w-3.5" /> 删除
        </Button>
        <Button size="sm" variant="ghost" aria-label="清除选择" onClick={() => { setSelected(new Set()); setSelectionMode(false) }}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    )}

    <NoticeStack
      items={toasts.items.map((t) => ({
        id: t.id,
        ok: t.ok,
        message: t.message,
        leaving: t.leaving,
        fadeMs: t.fadeMs,
        meta: t.latency_ms > 0 ? `${t.latency_ms}ms` : undefined,
      }))}
      onDismiss={toasts.leave}
    />

    <div className="space-y-6">
      <div className="page-heading">
        <div><div className="eyebrow mb-2 flex items-center gap-2"><Box className="h-3.5 w-3.5" /> 模型目录</div><h1 className="page-title">真实模型</h1><p className="page-description">按 Provider 管理真实模型，客户端仅可通过模型映射调用。</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 w-40 pl-8 text-xs"
              placeholder="模型名"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                if (searchTimer.current) clearTimeout(searchTimer.current)
                searchTimer.current = setTimeout(() => setDebouncedSearch(e.target.value), 200)
              }}
            />
          </div>
          <Select value={protocol} onValueChange={(v) => setProtocol(v as typeof protocol)}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部协议</SelectItem>
              <SelectItem value="openai">openai</SelectItem>
              <SelectItem value="anthropic">anthropic</SelectItem>
            </SelectContent>
          </Select>
          <Select value={providerId} onValueChange={setProviderId}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部 Provider</SelectItem>
              {(providers.data ?? []).filter((p) => p.enabled === 1).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> 手动添加</Button>
        </div>
      </div>

      <div className="console-toolbar console-surface">
        <div className="text-sm font-medium">
          模型列表
          {filtered.length > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">（{filtered.length} 个）</span>}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={onlyEnabled} onCheckedChange={setOnlyEnabled} aria-label="仅显示已启用模型" />
            <span>仅启用</span>
          </div>
          <Button size="sm" variant={selectionMode ? 'secondary' : 'ghost'} onClick={() => { if (selectionMode) setSelected(new Set()); setSelectionMode(!selectionMode) }}>
            <ListChecks className="h-4 w-4" /> 多选
          </Button>
          {selectionMode && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={allFilteredSelected ? true : selectedModels.length > 0 ? 'indeterminate' : false}
                onCheckedChange={selectAll}
                aria-label="全选当前筛选下的全部模型"
              />
              <span>全选筛选</span>
            </label>
          )}
        </div>
      </div>

      <section aria-label="真实模型分组" className="space-y-4">
        {modelGroups.map((entry) => renderProviderGroup(entry))}
        {!filtered.length && !models.isLoading && (
          <Card className="console-surface">
            <CardContent className="flex h-32 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Box className="h-8 w-8" />
              <p className="text-sm">{(models.data ?? []).length === 0 ? '还没有模型' : '当前筛选条件下无模型'}</p>
              {(models.data ?? []).length === 0 && (
                <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" /> 手动添加
                </Button>
              )}
            </CardContent>
          </Card>
        )}
        {models.isLoading && (
          <Card className="console-surface">
            <CardContent className="flex h-24 items-center justify-center text-sm text-muted-foreground">加载中...</CardContent>
          </Card>
        )}
      </section>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动添加模型</DialogTitle>
            <DialogDescription>添加后自动启用，并自动建立同名模型映射</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={addForm.provider_id} onValueChange={(v) => setAddForm({ ...addForm, provider_id: v })}>
                <SelectTrigger><SelectValue placeholder="选择 Provider" /></SelectTrigger>
                <SelectContent>
                  {(providers.data ?? []).filter((p) => p.enabled === 1).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name} ({p.protocol})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Model ID</Label>
              <Input value={addForm.model_id} onChange={(e) => setAddForm({ ...addForm, model_id: e.target.value })} placeholder="gpt-4o / openai/gpt-4" />
              <p className="text-xs text-muted-foreground">可包含 /，如 openai/gpt-4</p>
            </div>
            <div className="space-y-1.5">
              <Label>显示名称（可选）</Label>
              <Input value={addForm.display_name} onChange={(e) => setAddForm({ ...addForm, display_name: e.target.value })} placeholder="GPT-4o" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
            <Button onClick={() => addMutation.mutate()} disabled={addMutation.isPending || !addForm.provider_id || !addForm.model_id.trim()}>
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!testTarget} onOpenChange={(open) => !open && setTestTarget(null)}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>模型测活</DialogTitle>
            <DialogDescription>
              {testTarget ? `${testTarget.provider_name} / ${testTarget.model_id}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain py-2 pr-1">
            <div className="space-y-1.5">
              <Label>提示词</Label>
              <Textarea value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} rows={3} placeholder="留空使用默认提示词" />
              <p className="text-xs text-muted-foreground">禁止使用 "hi/hello/你好/测试/test/1" 等无意义短词</p>
            </div>
            {testResult !== null && (
              <div className="rounded-md border p-3">
                {testLatency !== null && <p className="mb-1.5 text-xs text-muted-foreground">耗时 {testLatency}ms</p>}
                <div className="max-h-72 overflow-y-auto">
                  <MarkdownRenderer content={testResult} />
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="shrink-0 border-t pt-2 sm:border-t-0">
            <Button variant="outline" onClick={() => setTestTarget(null)}>关闭</Button>
            <Button onClick={() => testTarget && doTest(testTarget, testPrompt)} disabled={!testTarget || runTest.isPending}>
              {runTest.isPending ? '测试中...' : '开始测试'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </>
  )
}
