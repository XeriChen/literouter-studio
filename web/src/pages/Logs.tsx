import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, RotateCw, Trash2, ScrollText, Settings2 } from 'lucide-react'
import { api } from '@/api/client'
import type { AuditRow, LogRow, Provider } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const RESOURCE_LABELS: Record<string, string> = {
  auth: '认证',
  provider: 'Provider',
  provider_group: 'Provider 分组',
  model: '模型',
  alias: '映射',
  alias_group: '映射分组',
  alias_target: '映射候选',
  settings: '设置',
  token: '令牌',
  backup: '备份',
  logs: '日志',
}

const ACTION_LABELS: Record<string, string> = {
  login: '登录',
  login_failed: '登录失败',
  create: '新建',
  update: '更新',
  delete: '删除',
  test: '测活',
  fetch: '拉取模型',
  import: '导入',
  export: '导出',
  reset: '重置',
  clear: '清空',
  batch_enable: '批量启用',
  batch_delete: '批量删除',
  activate: '设为当前',
  reorder: '重排优先级',
}

function statusBadge(status: number | null) {
  if (status == null) return <Badge variant="outline">-</Badge>
  if (status < 400) return <Badge variant="success">{status}</Badge>
  if (status < 500) return <Badge variant="warning">{status}</Badge>
  return <Badge variant="destructive">{status}</Badge>
}

function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">第 {page} / {totalPages} 页</span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" /> 上一页
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          下一页 <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function AccessLogsTab() {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [protocol, setProtocol] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [debouncedModel, setDebouncedModel] = useState('')
  const [status, setStatus] = useState('')
  const modelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<Provider[]>('/api/providers'),
  })

  const logs = useQuery({
    queryKey: ['logs', page, protocol, providerId, debouncedModel, status],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (protocol) p.set('protocol', protocol)
      if (providerId) p.set('provider_id', providerId)
      if (debouncedModel.trim()) p.set('model', debouncedModel.trim())
      if (status.trim()) p.set('status', status.trim())
      return api<{ total: number; rows: LogRow[] }>(`/api/logs?${p.toString()}`)
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <p className="text-sm text-muted-foreground">模型访问请求记录，共 {total} 条</p>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="刷新代理访问日志" title="刷新" onClick={() => logs.refetch()} disabled={logs.isFetching}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => { if (window.confirm('确定清空所有代理访问日志？此操作不可撤销。')) clearMutation.mutate() }} disabled={clearMutation.isPending}>
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

      <Card className="console-surface shadow-none">
        <CardContent className="p-0">
          <Table className="data-table">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">时间</TableHead>
                <TableHead>方法</TableHead>
                <TableHead>路径</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>耗时</TableHead>
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
                  <TableCell className="pr-6 text-xs text-muted-foreground">{r.latency_ms != null ? `${r.latency_ms}ms` : '-'}</TableCell>
                </TableRow>
              ))}
              {!logs.data?.rows.length && !logs.isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <ScrollText className="h-8 w-8" />
                      <p className="text-sm">暂无代理访问日志</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {logs.isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">加载中...</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPage={setPage} />
    </div>
  )
}

function AuditLogsTab() {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [resource, setResource] = useState('')

  const auditLogs = useQuery({
    queryKey: ['audit-logs', page, resource],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (resource) p.set('resource', resource)
      return api<{ total: number; rows: AuditRow[] }>(`/api/audit-logs?${p.toString()}`)
    },
  })

  const clearMutation = useMutation({
    mutationFn: () => api('/api/audit-logs', { method: 'DELETE' }),
    onSuccess: () => {
      setPage(1)
      qc.invalidateQueries({ queryKey: ['audit-logs'] })
    },
  })

  const total = auditLogs.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <p className="text-sm text-muted-foreground">网站配置操作记录，共 {total} 条</p>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="刷新配置操作日志" title="刷新" onClick={() => auditLogs.refetch()} disabled={auditLogs.isFetching}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => { if (window.confirm('确定清空所有配置操作日志？此操作不可撤销。')) clearMutation.mutate() }} disabled={clearMutation.isPending}>
          <Trash2 className="h-4 w-4" /> 清空
        </Button>
      </div>

      <Select value={resource} onValueChange={(v) => { setResource(v); setPage(1) }}>
        <SelectTrigger className="w-40"><SelectValue placeholder="资源类型" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="">全部类型</SelectItem>
          {Object.entries(RESOURCE_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Card className="console-surface shadow-none">
        <CardContent className="p-0">
          <Table className="data-table">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">时间</TableHead>
                <TableHead>资源</TableHead>
                <TableHead>操作</TableHead>
                <TableHead>对象</TableHead>
                <TableHead>详情</TableHead>
                <TableHead className="pr-6">状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(auditLogs.data?.rows ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap pl-6 text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-xs">{RESOURCE_LABELS[r.resource] ?? r.resource}</TableCell>
                  <TableCell className="text-xs">{ACTION_LABELS[r.action] ?? r.action}</TableCell>
                  <TableCell className="max-w-[160px] truncate font-mono text-xs">{r.target ?? '-'}</TableCell>
                  <TableCell className="max-w-[360px] truncate text-xs" title={r.detail ?? undefined}>{r.detail ?? '-'}</TableCell>
                  <TableCell className="pr-6">{statusBadge(r.status)}</TableCell>
                </TableRow>
              ))}
              {!auditLogs.data?.rows.length && !auditLogs.isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Settings2 className="h-8 w-8" />
                      <p className="text-sm">暂无配置操作日志</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {auditLogs.isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">加载中...</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPage={setPage} />
    </div>
  )
}

export default function Logs() {
  return (
    <div className="page-shell space-y-5">
      <div className="page-heading"><div><div className="eyebrow mb-2 flex items-center gap-2"><ScrollText className="h-3.5 w-3.5" /> 请求审计</div><h1 className="page-title">Logs</h1><p className="page-description">访问与配置操作记录。</p></div></div>
      <Tabs defaultValue="access">
        <TabsList>
          <TabsTrigger value="access">代理访问</TabsTrigger>
          <TabsTrigger value="config">配置操作</TabsTrigger>
        </TabsList>
        <TabsContent value="access"><AccessLogsTab /></TabsContent>
        <TabsContent value="config"><AuditLogsTab /></TabsContent>
      </Tabs>
    </div>
  )
}
