import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, RefreshCw, Search, Trash2, Unlock, Wifi, X, ServerOff } from 'lucide-react'
import { api } from '@/api/client'
import type { Provider } from '@/api/types'
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
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface ProviderForm {
  name: string
  protocol: 'openai' | 'anthropic'
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
  base_url: '',
  api_key: '',
  anthropic_version: '',
  proxy_url: '',
  timeout_ms: '',
  model_filter: '',
  custom_headers: '{}',
}

export default function Providers() {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [result, setResult] = useState<{ message: string; ok: boolean } | null>(null)
  const [fetchDialog, setFetchDialog] = useState<{ providerId: string; providerName: string } | null>(null)
  const [upstreamModels, setUpstreamModels] = useState<string[]>([])
  const [upstreamLoading, setUpstreamLoading] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [modelSearch, setModelSearch] = useState('')

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<Provider[]>('/api/providers'),
  })

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  /** 将 API Key 输入的内容按 Base64 解码并直接回填 */
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
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      setForm({ ...form, api_key: decoded })
      setResult({ message: '已解码为明文并回填', ok: true })
    } catch {
      setResult({ message: 'Base64 解码失败（内容可能不是文本）', ok: false })
    }
  }

  function openEdit(p: Provider) {
    setEditing(p)
    setForm({
      name: p.name,
      protocol: p.protocol,
      base_url: p.base_url,
      api_key: p.auth.api_key ?? '',
      anthropic_version: p.auth.version ?? '',
      proxy_url: p.proxy_url ?? '',
      timeout_ms: p.timeout_ms == null ? '' : String(p.timeout_ms),
      custom_headers: JSON.stringify(p.custom_headers ?? {}, null, 2),
      model_filter: p.model_filter ?? '',
    })
    setDialogOpen(true)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const auth: Record<string, string> = {}
      if (form.api_key) auth.api_key = form.api_key
      if (form.protocol === 'anthropic' && form.anthropic_version.trim()) auth.version = form.anthropic_version.trim()
      const payload = {
        name: form.name,
        protocol: form.protocol,
        base_url: form.base_url,
        auth,
        proxy_url: form.proxy_url.trim() || null,
        timeout_ms: form.timeout_ms.trim() ? Number(form.timeout_ms) : null,
        model_filter: form.model_filter.trim() || null,
      }
      let custom_headers: Record<string, string> = {}
      try {
        custom_headers = JSON.parse(form.custom_headers || '{}')
      } catch {
        throw new Error('自定义请求头必须是合法 JSON 对象')
      }
      const body = { ...payload, custom_headers }
      if (editing) {
        return api(`/api/providers/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) })
      }
      return api('/api/providers', { method: 'POST', body: JSON.stringify(body) })
    },
    onSuccess: () => {
      setDialogOpen(false)
      qc.invalidateQueries({ queryKey: ['providers'] })
    },
  })

  const delMutation = useMutation({
    mutationFn: (id: string) => api(`/api/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  })

  const testMutation = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; status?: number; message: string }>(`/api/providers/${id}/test`, { method: 'POST' }),
    onSuccess: (data) => {
      setResult({ message: data.message, ok: data.ok })
    },
    onError: (err) => {
      setResult({ message: err instanceof Error ? err.message : '测试失败', ok: false })
    },
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
    } catch (err) {
      setResult({ message: `拉取失败：${err instanceof Error ? err.message : 'unknown'}`, ok: false })
      setFetchDialog(null)
    } finally {
      setUpstreamLoading(false)
    }
  }

  const importModelsMutation = useMutation({
    mutationFn: ({ providerId, modelIds }: { providerId: string; modelIds: string[] }) =>
      api<{ added: number; updated: number }>(`/api/providers/${providerId}/import-models`, {
        method: 'POST',
        body: JSON.stringify({ model_ids: modelIds }),
      }),
    onSuccess: (data) => {
      setResult({ message: `导入成功：新增 ${data.added}，刷新 ${data.updated}`, ok: true })
      setFetchDialog(null)
      qc.invalidateQueries({ queryKey: ['models'] })
    },
    onError: (err) => {
      setResult({ message: `导入失败：${err instanceof Error ? err.message : 'unknown'}`, ok: false })
    },
  })

  const filteredUpstream = useMemo(() => {
    if (!modelSearch.trim()) return upstreamModels
    const q = modelSearch.trim().toLowerCase()
    return upstreamModels.filter((id) => id.toLowerCase().includes(q))
  }, [upstreamModels, modelSearch])

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold">Providers</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">管理 LLM 服务接入点</p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4" /> 新增 Provider
        </Button>
      </div>

      {result && (
        <div className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300'}`}>
          <span>{result.message}</span>
          <button onClick={() => setResult(null)} className="ml-2 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <Card>
        <CardHeader className="py-4">
          <CardTitle className="text-sm font-medium">Provider 列表</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">名称</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="pr-6 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.data?.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-6 font-medium">{p.name}</TableCell>
                  <TableCell>
                    <Badge variant={p.protocol === 'openai' ? 'outline' : 'secondary'}>{p.protocol}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate font-mono text-xs">{p.base_url}</TableCell>
                  <TableCell>
                    <Badge variant={p.enabled ? 'success' : 'warning'}>{p.enabled ? '启用' : '禁用'}</Badge>
                  </TableCell>
                  <TableCell className="pr-6">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => testMutation.mutate(p.id)} disabled={testMutation.isPending}>
                        <Wifi className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openFetchDialog(p.id, p.name)}>
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                        编辑
                      </Button>
                      <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm(`确定删除 Provider「${p.name}」？关联的模型也会一并删除。`)) delMutation.mutate(p.id) }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!providers.data?.length && !providers.isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <ServerOff className="h-8 w-8" />
                      <p className="text-sm">还没有 Provider</p>
                      <Button variant="outline" size="sm" onClick={openCreate}>
                        <Plus className="h-4 w-4" /> 新增 Provider
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {providers.isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                    加载中...
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑 Provider' : '新增 Provider'}</DialogTitle>
            <DialogDescription>API Key 会以明文存储在本机数据库中，请妥善保管。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>名称</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：OpenAI 官方" />
              </div>
              <div className="space-y-1.5">
                <Label>协议</Label>
                <Select value={form.protocol} onValueChange={(v) => setForm({ ...form, protocol: v as ProviderForm['protocol'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">openai</SelectItem>
                    <SelectItem value="anthropic">anthropic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Base URL</Label>
              <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.openai.com" />
              <p className="text-xs text-muted-foreground">不含 /v1 后缀，网关会自动拼接</p>
            </div>
            <div className="space-y-1.5">
              <Label>API Key</Label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sk-..." />
                </div>
                <Button type="button" variant="outline" className="shrink-0" onClick={decodeApiKey} title="Base64 解码并回填为明文">
                  <Unlock className="h-3.5 w-3.5" /> 解码
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">如粘贴的是 Base64 编码的 Key，点击「解码」直接转成明文</p>
            </div>
            {form.protocol === 'anthropic' && (
              <div className="space-y-1.5">
                <Label>Anthropic Version（可选）</Label>
                <Input value={form.anthropic_version} onChange={(e) => setForm({ ...form, anthropic_version: e.target.value })} placeholder="2023-06-01（留空使用默认值）" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>代理 URL（可选）</Label>
                <Input value={form.proxy_url} onChange={(e) => setForm({ ...form, proxy_url: e.target.value })} placeholder="http://127.0.0.1:7890" />
              </div>
              <div className="space-y-1.5">
                <Label>超时毫秒</Label>
                <Input value={form.timeout_ms} onChange={(e) => setForm({ ...form, timeout_ms: e.target.value })} placeholder="120000（0 表示不超时）" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>自定义请求头</Label>
              <Textarea
                value={form.custom_headers}
                onChange={(e) => setForm({ ...form, custom_headers: e.target.value })}
                rows={3}
                className="font-mono text-xs"
                placeholder='{"X-Custom": "value"}'
              />
              <p className="text-xs text-muted-foreground">JSON 格式，不可覆盖 authorization / x-api-key / accept-encoding</p>
            </div>
            <div className="space-y-1.5">
              <Label>模型过滤规则（可选）</Label>
              <Input
                value={form.model_filter}
                onChange={(e) => setForm({ ...form, model_filter: e.target.value })}
                placeholder="grok-*,mimo-*"
              />
              <p className="text-xs text-muted-foreground">逗号分隔的前缀匹配规则，拉取时只入库匹配的模型。留空不过滤。例：gpt-*,claude-*</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !form.name.trim() || !form.base_url.trim()}>
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? '保存修改' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!fetchDialog} onOpenChange={(open) => { if (!open) setFetchDialog(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>选择要导入的模型</DialogTitle>
            <DialogDescription>
              {fetchDialog ? `从「${fetchDialog.providerName}」拉取到 ${upstreamModels.length} 个模型` : ''}
            </DialogDescription>
          </DialogHeader>
          {upstreamLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在拉取模型列表...
            </div>
          ) : (
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8 text-sm"
                  placeholder="搜索模型..."
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>已选 {selectedModels.size} / {upstreamModels.length}</span>
                <div className="flex gap-2">
                  <button className="hover:underline" onClick={() => setSelectedModels(new Set(upstreamModels))}>全选</button>
                  <button className="hover:underline" onClick={() => setSelectedModels(new Set())}>全不选</button>
                </div>
              </div>
              <div className="h-64 overflow-y-auto rounded-md border p-2 space-y-0.5">
                {filteredUpstream.map((id) => (
                  <label key={id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedModels.has(id)}
                      onChange={(e) => {
                        const next = new Set(selectedModels)
                        if (e.target.checked) next.add(id)
                        else next.delete(id)
                        setSelectedModels(next)
                      }}
                      className="h-3.5 w-3.5"
                    />
                    <span className="font-mono text-xs">{id}</span>
                  </label>
                ))}
                {!filteredUpstream.length && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {upstreamModels.length === 0 ? '未获取到模型' : '无匹配模型'}
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFetchDialog(null)}>取消</Button>
            <Button
              disabled={selectedModels.size === 0 || importModelsMutation.isPending}
              onClick={() => {
                if (fetchDialog) {
                  importModelsMutation.mutate({ providerId: fetchDialog.providerId, modelIds: [...selectedModels] })
                }
              }}
            >
              {importModelsMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              导入 {selectedModels.size} 个模型
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
