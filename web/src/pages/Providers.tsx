import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, RefreshCw, Trash2, Wifi } from 'lucide-react'
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
  proxy_url: string
  timeout_ms: string
  custom_headers: string
}

const EMPTY_FORM: ProviderForm = {
  name: '',
  protocol: 'openai',
  base_url: '',
  api_key: '',
  proxy_url: '',
  timeout_ms: '',
  custom_headers: '{}',
}

export default function Providers() {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [result, setResult] = useState<{ providerId: string; message: string } | null>(null)
  const [fetching, setFetching] = useState<string | null>(null)

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{ ok: true; data: Provider[] }>('/api/providers').then((r) => r.data),
  })

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  function openEdit(p: Provider) {
    setEditing(p)
    setForm({
      name: p.name,
      protocol: p.protocol,
      base_url: p.base_url,
      api_key: p.auth.api_key ?? '',
      proxy_url: p.proxy_url ?? '',
      timeout_ms: p.timeout_ms == null ? '' : String(p.timeout_ms),
      custom_headers: JSON.stringify(p.custom_headers ?? {}, null, 2),
    })
    setDialogOpen(true)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name,
        protocol: form.protocol,
        base_url: form.base_url,
        auth: form.api_key ? { api_key: form.api_key } : {},
        proxy_url: form.proxy_url.trim() || null,
        timeout_ms: form.timeout_ms.trim() ? Number(form.timeout_ms) : null,
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
    mutationFn: (id: string) => api<{ ok: true; data: { ok: boolean; status?: number; message: string } }>(`/api/providers/${id}/test`, { method: 'POST' }),
  })

  async function fetchModels(id: string) {
    setFetching(id)
    try {
      const res = await api<{ ok: true; data: { added: number; updated: number } }>(`/api/providers/${id}/fetch-models`, { method: 'POST' })
      setResult({ providerId: id, message: `拉取成功：新增 ${res.data.added}，刷新 ${res.data.updated}` })
      qc.invalidateQueries({ queryKey: ['providers'] })
      qc.invalidateQueries({ queryKey: ['models'] })
    } catch (err) {
      setResult({ providerId: id, message: `拉取失败：${err instanceof Error ? err.message : 'unknown'}` })
    } finally {
      setFetching(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Providers</h1>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> 新增 Provider
        </Button>
      </div>

      {result && <p className="text-sm text-muted-foreground">{result.message}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Provider 列表</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>已启用</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.data?.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>
                    <Badge variant={p.protocol === 'openai' ? 'outline' : 'secondary'}>{p.protocol}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate">{p.base_url}</TableCell>
                  <TableCell>
                    <Badge variant={p.enabled ? 'success' : 'warning'}>{p.enabled ? '启用' : '禁用'}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" onClick={() => testMutation.mutate(p.id)}>
                        <Wifi className="h-3.5 w-3.5" /> 测试
                      </Button>
                      <Button variant="outline" size="sm" disabled={fetching === p.id} onClick={() => fetchModels(p.id)}>
                        <RefreshCw className={`h-3.5 w-3.5 ${fetching === p.id ? 'animate-spin' : ''}`} /> 拉取模型
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openEdit(p)}>编辑</Button>
                      <Button variant="ghost" size="sm" onClick={() => delMutation.mutate(p.id)}>删除</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!providers.data?.length && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    {providers.isLoading ? '加载中...' : '暂无 Provider，点击右上角新增'}
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
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：OpenAI 官方" />
              </div>
              <div className="space-y-2">
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
            <div className="space-y-2">
              <Label>Base URL（不含 /v1 后缀）</Label>
              <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.openai.com" />
            </div>
            <div className="space-y-2">
              <Label>API Key</Label>
              <Input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sk-..." />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>代理 URL（可选）</Label>
                <Input value={form.proxy_url} onChange={(e) => setForm({ ...form, proxy_url: e.target.value })} placeholder="http://127.0.0.1:7890" />
              </div>
              <div className="space-y-2">
                <Label>超时毫秒（0 表示不超时）</Label>
                <Input value={form.timeout_ms} onChange={(e) => setForm({ ...form, timeout_ms: e.target.value })} placeholder="120000" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>自定义请求头（JSON，不可覆盖认证头/accept-encoding）</Label>
              <Textarea
                value={form.custom_headers}
                onChange={(e) => setForm({ ...form, custom_headers: e.target.value })}
                rows={3}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !form.name.trim() || !form.base_url.trim()}>
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}