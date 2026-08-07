import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Loader2, Plus, Trash2, X, Box } from 'lucide-react'
import { api } from '@/api/client'
import type { Provider, ProviderModel } from '@/api/types'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

export default function Models() {
  const qc = useQueryClient()
  const [protocol, setProtocol] = useState<'all' | 'openai' | 'anthropic'>('all')
  const [providerId, setProviderId] = useState('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ provider_id: '', model_id: '', display_name: '' })
  const [testTarget, setTestTarget] = useState<ProviderModel | null>(null)
  const [testPrompt, setTestPrompt] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testLatency, setTestLatency] = useState<number | null>(null)
  const [quickTestId, setQuickTestId] = useState<string | null>(null)

  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<{ ok: true; data: ProviderModel[] }>('/api/models').then((r) => r.data),
  })
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{ ok: true; data: Provider[] }>('/api/providers').then((r) => r.data),
  })

  const filtered = useMemo(() => {
    let rows = models.data ?? []
    if (protocol !== 'all') rows = rows.filter((m) => m.protocol === protocol)
    if (providerId !== 'all') rows = rows.filter((m) => m.provider_id === providerId)
    return rows
  }, [models.data, protocol, providerId])

  const toggleMutation = useMutation({
    mutationFn: (m: ProviderModel) =>
      api(`/api/models`, {
        method: 'PATCH',
        body: JSON.stringify({ provider_id: m.provider_id, model_id: m.model_id, enabled: m.enabled ? 0 : 1 }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
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
    },
  })

  const delMutation = useMutation({
    mutationFn: (m: ProviderModel) =>
      api('/api/models', { method: 'DELETE', body: JSON.stringify({ provider_id: m.provider_id, model_id: m.model_id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }),
  })

  const runTest = useMutation({
    mutationFn: ({ model, prompt }: { model: ProviderModel; prompt: string }) =>
      api<{ ok: true; data: { reply: string; latency_ms: number } }>('/api/models/test', {
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
        onSuccess: (r) => {
          setTestResult(r.data.reply)
          setTestLatency(r.data.latency_ms)
        },
        onError: (err) => setTestResult(`测试失败：${err instanceof Error ? err.message : 'unknown'}`),
      },
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Models</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">管理可用模型，同协议内同名互斥</p>
        </div>
        <div className="flex items-center gap-2">
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
              {(providers.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> 手动添加</Button>
        </div>
      </div>

      <Card>
        <CardHeader className="py-4">
          <CardTitle className="text-sm font-medium">
            模型列表
            {filtered.length > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">（{filtered.length} 个）</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>启用</TableHead>
                <TableHead>测活</TableHead>
                <TableHead className="pr-6 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((m) => (
                <TableRow key={`${m.provider_id}/${m.model_id}`}>
                  <TableCell className="pl-6">{m.provider_name}</TableCell>
                  <TableCell className="max-w-[220px] truncate font-mono text-xs">{m.model_id}</TableCell>
                  <TableCell><Badge variant={m.protocol === 'openai' ? 'outline' : 'secondary'}>{m.protocol}</Badge></TableCell>
                  <TableCell><Badge variant="secondary">{m.source}</Badge></TableCell>
                  <TableCell>
                    <Switch
                      checked={!!m.enabled}
                      disabled={!m.provider_enabled}
                      onCheckedChange={() => toggleMutation.mutate(m)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => { setTestTarget(m); setTestPrompt(''); setTestResult(null); setTestLatency(null) }}>
                        <Activity className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" disabled={quickTestId === `${m.provider_id}/${m.model_id}`}
                        onClick={() => {
                          const key = `${m.provider_id}/${m.model_id}`
                          setQuickTestId(key)
                          runTest.mutate(
                            { model: m, prompt: '现在的美国总统是谁' },
                            { onSettled: () => setQuickTestId(null) },
                          )
                        }}>
                        {quickTestId === `${m.provider_id}/${m.model_id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '快速测试'}
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="pr-6">
                    <div className="flex justify-end">
                      <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm(`确定删除模型「${m.model_id}」？`)) delMutation.mutate(m) }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!filtered.length && !models.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Box className="h-8 w-8" />
                      <p className="text-sm">{(models.data ?? []).length === 0 ? '还没有模型' : '当前筛选条件下无模型'}</p>
                      {(models.data ?? []).length === 0 && (
                        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                          <Plus className="h-4 w-4" /> 手动添加
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {models.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">加载中...</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动添加模型</DialogTitle>
            <DialogDescription>添加后需手动启用才会出现在代理路由中</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={addForm.provider_id} onValueChange={(v) => setAddForm({ ...addForm, provider_id: v })}>
                <SelectTrigger><SelectValue placeholder="选择 Provider" /></SelectTrigger>
                <SelectContent>
                  {(providers.data ?? []).map((p) => (
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>模型测活</DialogTitle>
            <DialogDescription>
              {testTarget ? `${testTarget.provider_name} / ${testTarget.model_id}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>提示词</Label>
            <Textarea value={testPrompt} onChange={(e) => setTestPrompt(e.target.value)} rows={3} placeholder="留空使用默认提示词" />
            <p className="text-xs text-muted-foreground">禁止使用 "hi/hello/你好/测试/test/1" 等无意义短词</p>
          </div>
          {testResult !== null && (
            <div className="rounded-md border p-3">
              {testLatency !== null && <p className="mb-1.5 text-xs text-muted-foreground">耗时 {testLatency}ms</p>}
              <MarkdownRenderer content={testResult} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestTarget(null)}>关闭</Button>
            <Button onClick={() => testTarget && doTest(testTarget, testPrompt)} disabled={!testTarget || runTest.isPending}>
              {runTest.isPending ? '测试中...' : '开始测试'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
