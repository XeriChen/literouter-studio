import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Trash2, ScrollText } from 'lucide-react'
import { api } from '@/api/client'
import type { LogRow, Provider } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

function statusBadge(status: number | null) {
  if (status == null) return <Badge variant="outline">-</Badge>
  if (status < 400) return <Badge variant="success">{status}</Badge>
  if (status < 500) return <Badge variant="warning">{status}</Badge>
  return <Badge variant="destructive">{status}</Badge>
}

export default function Logs() {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [protocol, setProtocol] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [debouncedModel, setDebouncedModel] = useState('')
  const [status, setStatus] = useState('')
  const modelTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{ ok: true; data: Provider[] }>('/api/providers').then((r) => r.data),
  })

  const logs = useQuery({
    queryKey: ['logs', page, protocol, providerId, debouncedModel, status],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (protocol) p.set('protocol', protocol)
      if (providerId) p.set('provider_id', providerId)
      if (debouncedModel.trim()) p.set('model', debouncedModel.trim())
      if (status.trim()) p.set('status', status.trim())
      return api<{ ok: true; data: { total: number; rows: LogRow[] } }>(`/api/logs?${p.toString()}`).then((r) => r.data)
    },
  })

  const clearMutation = useMutation({
    mutationFn: () => api('/api/logs', { method: 'DELETE' }),
    onSuccess: () => {
      setPage(1)
      qc.invalidateQueries({ queryKey: ['logs'] })
    },
  })

  const total = logs.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Logs</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">代理请求记录，共 {total} 条</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { if (window.confirm('确定清空所有日志？此操作不可撤销。')) clearMutation.mutate() }} disabled={clearMutation.isPending}>
          <Trash2 className="h-4 w-4" /> 清空
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={protocol} onValueChange={(v) => { setProtocol(v); setPage(1) }}>
          <SelectTrigger className="w-28"><SelectValue placeholder="协议" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部协议</SelectItem>
            <SelectItem value="openai">openai</SelectItem>
            <SelectItem value="anthropic">anthropic</SelectItem>
          </SelectContent>
        </Select>
        <Select value={providerId} onValueChange={(v) => { setProviderId(v); setPage(1) }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Provider" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部 Provider</SelectItem>
            {(providers.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-36"
          placeholder="模型名"
          aria-label="按模型名筛选"
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
            setPage(1)
            if (modelTimerRef.current) clearTimeout(modelTimerRef.current)
            modelTimerRef.current = setTimeout(() => setDebouncedModel(e.target.value), 300)
          }}
        />
        <Input
          className="w-24"
          placeholder="状态码"
          aria-label="按状态码筛选"
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1) }}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">时间</TableHead>
                <TableHead>方法</TableHead>
                <TableHead>路径</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead className="pr-6">错误码</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(logs.data?.rows ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap pl-6 text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</TableCell>
                  <TableCell className="font-mono text-xs">{r.method}</TableCell>
                  <TableCell className="max-w-[180px] truncate font-mono text-xs">{r.path}</TableCell>
                  <TableCell className="max-w-[140px] truncate font-mono text-xs">{r.model ?? '-'}</TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.latency_ms != null ? `${r.latency_ms}ms` : '-'}</TableCell>
                  <TableCell className="pr-6 font-mono text-xs text-muted-foreground">{r.error_code ?? '-'}</TableCell>
                </TableRow>
              ))}
              {!logs.data?.rows.length && !logs.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <ScrollText className="h-8 w-8" />
                      <p className="text-sm">暂无日志记录</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {logs.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">加载中...</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">第 {page} / {totalPages} 页</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" /> 上一页
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              下一页 <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
