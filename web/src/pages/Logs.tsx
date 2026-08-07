import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
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
  const [status, setStatus] = useState('')

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{ ok: true; data: Provider[] }>('/api/providers').then((r) => r.data),
  })

  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
  if (protocol) params.set('protocol', protocol)
  if (providerId) params.set('provider_id', providerId)
  if (model.trim()) params.set('model', model.trim())
  if (status.trim()) params.set('status', status.trim())

  const logs = useQuery({
    queryKey: ['logs', page, protocol, providerId, model, status],
    queryFn: () =>
      api<{ ok: true; data: { total: number; rows: LogRow[] } }>(`/api/logs?${params.toString()}`).then((r) => r.data),
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Logs</h1>
        <Button variant="destructive" onClick={() => clearMutation.mutate()} disabled={clearMutation.isPending}>
          <Trash2 className="h-4 w-4" /> 清空日志
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={protocol} onValueChange={(v) => { setProtocol(v); setPage(1) }}>
          <SelectTrigger className="w-32"><SelectValue placeholder="协议" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            <SelectItem value="openai">openai</SelectItem>
            <SelectItem value="anthropic">anthropic</SelectItem>
          </SelectContent>
        </Select>
        <Select value={providerId} onValueChange={(v) => { setProviderId(v); setPage(1) }}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Provider" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            {(providers.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-36"
          placeholder="模型过滤"
          value={model}
          onChange={(e) => { setModel(e.target.value); setPage(1) }}
        />
        <Input
          className="w-28"
          placeholder="状态码"
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1) }}
        />
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>方法</TableHead>
                <TableHead>路径</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead>错误码</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(logs.data?.rows ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs">{new Date(r.created_at).toLocaleString()}</TableCell>
                  <TableCell>{r.method}</TableCell>
                  <TableCell className="max-w-[200px] truncate font-mono text-xs">{r.path}</TableCell>
                  <TableCell className="max-w-[160px] truncate">{r.model ?? '-'}</TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell>{r.latency_ms != null ? `${r.latency_ms}ms` : '-'}</TableCell>
                  <TableCell className="font-mono text-xs">{r.error_code ?? '-'}</TableCell>
                </TableRow>
              ))}
              {!logs.data?.rows.length && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">暂无日志</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}