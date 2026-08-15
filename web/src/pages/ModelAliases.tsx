import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Check, Activity, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { api } from '@/api/client'
import type { ModelAlias, Provider, ProviderModel } from '@/api/types'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/** 行内指向热切换：Provider + 目标模型两个下拉，改动即 PATCH 生效 */
function TargetSelects({
  a,
  protocolProviders,
  allModels,
  onRetarget,
}: {
  a: ModelAlias
  protocolProviders: Provider[]
  allModels: ProviderModel[]
  onRetarget: (a: ModelAlias) => void
}) {
  const [providerId, setProviderId] = useState(a.provider_id)
  useEffect(() => setProviderId(a.provider_id), [a.provider_id])
  const providerModels = useMemo(
    () => allModels.filter((m) => m.provider_id === providerId),
    [allModels, providerId],
  )
  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={providerId}
        onValueChange={(v) => {
          setProviderId(v)
          const first = allModels.find((m) => m.provider_id === v && m.enabled === 1)
          onRetarget({ ...a, provider_id: v, model_id: first?.model_id ?? '' })
        }}
      >
        <SelectTrigger className="h-7 w-32 text-xs"><SelectValue placeholder="选择 Provider" /></SelectTrigger>
        <SelectContent>
          {protocolProviders.map((p) => (
            <SelectItem key={p.id} value={p.id} disabled={!p.enabled}>{p.name}{p.enabled ? '' : '（已禁用）'}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        key={providerId}
        value={a.model_id}
        onValueChange={(v) => onRetarget({ ...a, provider_id: providerId, model_id: v })}
      >
        <SelectTrigger className="h-7 w-48 text-xs"><SelectValue placeholder="选择模型" /></SelectTrigger>
        <SelectContent>
          {providerModels.map((m) => (
            <SelectItem key={m.model_id} value={m.model_id} disabled={!m.enabled}>
              {m.display_name || m.model_id}
              {m.enabled ? '' : '（未启用）'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export default function ModelAliases() {
  const qc = useQueryClient()
  const [protocol, setProtocol] = useState<'all' | 'openai' | 'anthropic'>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ protocol: 'openai', alias_name: '', provider_id: '', model_id: '' })
  const [renaming, setRenaming] = useState<ModelAlias | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [toasts, setToasts] = useState<Array<{ id: number; ok: boolean; message: string; latency_ms: number }>>([])
  const [quickTestId, setQuickTestId] = useState<string | null>(null)
  const toastIdRef = useRef(0)

  function addToast(ok: boolean, message: string, latency_ms = 0) {
    const id = ++toastIdRef.current
    setToasts((prev) => [...prev, { id, ok, message, latency_ms }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
  }

  const aliases = useQuery({
    queryKey: ['aliases'],
    queryFn: () => api<ModelAlias[]>('/api/aliases'),
  })
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<Provider[]>('/api/providers'),
  })
  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<ProviderModel[]>('/api/models'),
  })

  const filtered = useMemo(() => {
    let rows = aliases.data ?? []
    if (protocol !== 'all') rows = rows.filter((a) => a.protocol === protocol)
    return rows
  }, [aliases.data, protocol])

  const providersOfProtocol = useMemo(
    () => (providers.data ?? []).filter((p) => p.protocol === addForm.protocol),
    [providers.data, addForm.protocol],
  )
  const enabledModelsOfProvider = useMemo(
    () =>
      (models.data ?? []).filter(
        (m) => m.provider_id === addForm.provider_id && m.enabled === 1 && m.provider_enabled === 1,
      ),
    [models.data, addForm.provider_id],
  )
  const nameTaken = filtered.some(
    (a) => a.protocol === addForm.protocol && a.alias_name === addForm.alias_name.trim() && a.alias_name.trim(),
  )
  const renameTaken =
    renaming !== null &&
    (aliases.data ?? []).some(
      (x) =>
        x.protocol === renaming.protocol &&
        x.alias_name === renameValue.trim() &&
        x.alias_name !== renaming.alias_name,
    )

  function saveRename() {
    if (!renaming) return
    const name = renameValue.trim()
    if (!name || name === renaming.alias_name) {
      setRenaming(null)
      return
    }
    renameMutation.mutate({ ...renaming, new_alias_name: name })
  }

  const addMutation = useMutation({
    mutationFn: () =>
      api('/api/aliases', {
        method: 'POST',
        body: JSON.stringify({ ...addForm, alias_name: addForm.alias_name.trim() }),
      }),
    onSuccess: () => {
      setAddOpen(false)
      setAddForm({ protocol: 'openai', alias_name: '', provider_id: '', model_id: '' })
      qc.invalidateQueries({ queryKey: ['aliases'] })
      addToast(true, '映射创建成功')
    },
    onError: (err) => addToast(false, err instanceof Error ? err.message : '创建失败'),
  })

  const delMutation = useMutation({
    mutationFn: (a: ModelAlias) =>
      api('/api/aliases', { method: 'DELETE', body: JSON.stringify({ protocol: a.protocol, alias_name: a.alias_name }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['aliases'] })
      addToast(true, '映射已删除')
    },
    onError: (err) => addToast(false, err instanceof Error ? err.message : '删除失败'),
  })

  const retargetMutation = useMutation({
    mutationFn: (a: ModelAlias) =>
      api('/api/aliases', {
        method: 'PATCH',
        body: JSON.stringify({ protocol: a.protocol, alias_name: a.alias_name, provider_id: a.provider_id, model_id: a.model_id }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['aliases'] }),
    onError: (err) => addToast(false, err instanceof Error ? err.message : '指向更新失败'),
  })

  const renameMutation = useMutation({
    mutationFn: (a: ModelAlias & { new_alias_name: string }) =>
      api('/api/aliases', {
        method: 'PATCH',
        body: JSON.stringify({
          protocol: a.protocol,
          alias_name: a.alias_name,
          new_alias_name: a.new_alias_name,
          provider_id: a.provider_id,
          model_id: a.model_id,
        }),
      }),
    onSuccess: () => {
      setRenaming(null)
      qc.invalidateQueries({ queryKey: ['aliases'] })
      addToast(true, '映射名已更新')
    },
    onError: (err) => addToast(false, err instanceof Error ? err.message : '重命名失败'),
  })

  const runTest = useMutation({
    mutationFn: (a: ModelAlias) =>
      api<{ reply: string; latency_ms: number }>('/api/models/test', {
        method: 'POST',
        body: JSON.stringify({ provider_id: a.provider_id, model_id: a.model_id }),
      }),
  })

  async function copyName(name: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(name)
      } else {
        const ta = document.createElement('textarea')
        ta.value = name
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      addToast(true, `已复制映射名：${name}`)
    } catch {
      addToast(false, '复制失败')
    }
  }

  return (
    <>
      {toasts.length > 0 && (
        <div className="fixed left-1/2 top-4 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-lg backdrop-blur-sm transition-all ${
                t.ok
                  ? 'border-emerald-200 bg-emerald-50/95 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/90 dark:text-emerald-200'
                  : 'border-red-200 bg-red-50/95 text-red-800 dark:border-red-800 dark:bg-red-950/90 dark:text-red-200'
              }`}
            >
              <span className="max-w-md line-clamp-2">{t.message}</span>
              {t.latency_ms > 0 && <span className="shrink-0 text-xs opacity-70">{t.latency_ms}ms</span>}
              <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} className="shrink-0 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="page-shell space-y-6">
        <div className="page-heading">
          <div><div className="eyebrow mb-2 flex items-center gap-2"><Activity className="h-3.5 w-3.5" /> 路由键</div><h1 className="page-title">模型映射</h1><p className="page-description">客户端可见的模型名，按协议隔离；映射指向已启用的真实模型。</p></div>
          <div className="flex items-center gap-2">
            <Select value={protocol} onValueChange={(v) => setProtocol(v as typeof protocol)}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部协议</SelectItem>
                <SelectItem value="openai">openai</SelectItem>
                <SelectItem value="anthropic">anthropic</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> 新建映射</Button>
          </div>
        </div>

        <Card className="console-surface shadow-none">
          <CardHeader className="border-b border-foreground/10 px-5 py-4">
            <CardTitle className="text-sm font-medium">
              映射列表
              {filtered.length > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">（{filtered.length} 个）</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table className="data-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">映射名</TableHead>
                  <TableHead>协议</TableHead>
                  <TableHead>指向</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="pr-6 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a) => (
                  <TableRow key={`${a.protocol}/${a.alias_name}`}>
                    <TableCell className="pl-6">
                      {renaming?.protocol === a.protocol && renaming.alias_name === a.alias_name ? (
                        <div className="flex items-center gap-1">
                          <Input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveRename()
                              if (e.key === 'Escape') setRenaming(null)
                            }}
                            className="h-7 w-44 font-mono text-xs"
                            placeholder="新映射名"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={!renameValue.trim() || renameTaken}
                            onClick={saveRename}
                            title="保存"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRenaming(null)} title="取消">
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{a.alias_name}</span>
                          <button
                            onClick={() => copyName(a.alias_name)}
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="复制映射名"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              setRenaming(a)
                              setRenameValue(a.alias_name)
                            }}
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="重命名映射名"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            disabled={quickTestId !== null}
                            onClick={() => {
                              const key = `${a.protocol}/${a.alias_name}`
                              setQuickTestId(key)
                              runTest.mutate(a, {
                                onSuccess: (data) => addToast(true, `${a.alias_name}: ${data.reply}`, data.latency_ms),
                                onError: (err) => addToast(false, `${a.alias_name}: ${err instanceof Error ? err.message : '测活失败'}`),
                                onSettled: () => setQuickTestId(null),
                              })
                            }}
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                            title="快速测活"
                          >
                            {quickTestId === `${a.protocol}/${a.alias_name}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Activity className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      )}
                    </TableCell>
                    <TableCell><Badge variant={a.protocol === 'openai' ? 'outline' : 'secondary'}>{a.protocol}</Badge></TableCell>
                    <TableCell>
                      <TargetSelects
                        a={a}
                        protocolProviders={providers.data?.filter((p) => p.protocol === a.protocol) ?? []}
                        allModels={models.data ?? []}
                        onRetarget={retargetMutation.mutate}
                      />
                    </TableCell>
                    <TableCell>
                      {!a.provider_enabled ? (
                        <Badge variant="destructive">Provider 已禁用</Badge>
                      ) : !a.target_enabled ? (
                        <Badge variant="destructive">目标模型未启用</Badge>
                      ) : (
                        <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">可用</Badge>
                      )}
                    </TableCell>
                    <TableCell className="pr-6">
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            if (window.confirm(`确定删除映射「${a.alias_name}」？`)) delMutation.mutate(a)
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!filtered.length && !aliases.isLoading && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center">
                      <div className="flex flex-col items-center gap-2 text-muted-foreground">
                        <p className="text-sm">还没有模型映射，客户端将无法调用任何模型</p>
                        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                          <Plus className="h-4 w-4" /> 新建映射
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {aliases.isLoading && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">加载中...</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建模型映射</DialogTitle>
            <DialogDescription>映射名按协议隔离；目标必须是已启用的真实模型</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>协议</Label>
              <Select
                value={addForm.protocol}
                onValueChange={(v) => setAddForm({ ...addForm, protocol: v as 'openai' | 'anthropic', provider_id: '', model_id: '' })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">openai</SelectItem>
                  <SelectItem value="anthropic">anthropic</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>映射名</Label>
              <Input
                value={addForm.alias_name}
                onChange={(e) => setAddForm({ ...addForm, alias_name: e.target.value })}
                placeholder="my-brain"
              />
              {nameTaken && <p className="text-xs text-red-500">该协议下已存在同名映射</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={addForm.provider_id} onValueChange={(v) => setAddForm({ ...addForm, provider_id: v, model_id: '' })}>
                <SelectTrigger><SelectValue placeholder="选择 Provider" /></SelectTrigger>
                <SelectContent>
                  {providersOfProtocol.map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={!p.enabled}>{p.name}{p.enabled ? '' : '（已禁用）'}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>目标模型（仅显示已启用）</Label>
              <Select value={addForm.model_id} onValueChange={(v) => setAddForm({ ...addForm, model_id: v })} disabled={!addForm.provider_id}>
                <SelectTrigger><SelectValue placeholder={addForm.provider_id ? '选择模型' : '先选择 Provider'} /></SelectTrigger>
                <SelectContent>
                  {enabledModelsOfProvider.map((m) => (
                    <SelectItem key={m.model_id} value={m.model_id}>{m.display_name || m.model_id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
            <Button
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !addForm.alias_name.trim() || !addForm.provider_id || !addForm.model_id || nameTaken}
            >
              {addMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />} 创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
