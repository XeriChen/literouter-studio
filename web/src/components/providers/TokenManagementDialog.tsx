import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Infinity as InfinityIcon,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { api } from '@/api/client'
import type { NewApiToken, NewApiTokenPage, Provider } from '@/api/types'
import type { ConfirmOptions } from '@/components/ConfirmDialog'
import { copyText } from '@/lib/clipboard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const PAGE_SIZE = 20

interface TokenForm {
  name: string
  unlimited: boolean
  quota_usd: string
  never_expire: boolean
  expire_at: string
  group: string
}

const EMPTY_TOKEN_FORM: TokenForm = { name: '', unlimited: false, quota_usd: '', never_expire: true, expire_at: '', group: '' }

/** unix 秒 → datetime-local 输入值（本地时区，精确到分钟）。 */
function toDatetimeLocal(sec: number): string {
  const d = new Date(sec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 到期展示：-1（或 <=0）为永不过期，否则本地日期。 */
function expiryLabel(sec: number): string {
  return sec <= 0 ? '永不' : new Date(sec * 1000).toLocaleString()
}

export function TokenManagementDialog({
  provider,
  onOpenChange,
  onResult,
  confirm,
  onPoolChanged,
}: {
  provider: Provider | null
  onOpenChange: (open: boolean) => void
  onResult: (result: { message: string; ok: boolean }) => void
  confirm: (options: ConfirmOptions) => Promise<boolean>
  onPoolChanged: () => void
}) {
  const qc = useQueryClient()
  const providerId = provider?.id ?? null
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [revealed, setRevealed] = useState<Record<number, string>>({})
  const [revealingId, setRevealingId] = useState<number | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingStatus, setEditingStatus] = useState<1 | 2>(1)
  // 编辑时透传保留 new-api 侧本网关不编辑的字段，避免整对象覆盖清空
  const [editingPreserved, setEditingPreserved] = useState<Pick<NewApiToken, 'model_limits_enabled' | 'model_limits' | 'allow_ips' | 'cross_group_retry'> | null>(null)
  const [form, setForm] = useState<TokenForm>({ ...EMPTY_TOKEN_FORM })

  useEffect(() => {
    setPage(1); setSelected(new Set()); setRevealed({})
    setFormOpen(false); setEditingId(null); setEditingPreserved(null); setForm({ ...EMPTY_TOKEN_FORM })
  }, [providerId])
  useEffect(() => { setSelected(new Set()) }, [page])

  const tokensQuery = useQuery({
    queryKey: ['newapi-tokens', providerId, page],
    queryFn: () => api<NewApiTokenPage>(`/api/providers/${providerId}/newapi/tokens?p=${page}&size=${PAGE_SIZE}`),
    enabled: !!providerId,
  })
  const items = tokensQuery.data?.items ?? []
  const total = tokensQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function invalidateTokens() {
    qc.invalidateQueries({ queryKey: ['newapi-tokens', providerId] })
  }

  async function handleReveal(token: NewApiToken) {
    if (revealed[token.id] !== undefined) {
      setRevealed((current) => { const next = { ...current }; delete next[token.id]; return next })
      return
    }
    setRevealingId(token.id)
    try {
      const { key } = await api<{ key: string }>(`/api/providers/${providerId}/newapi/tokens/${token.id}/reveal`, { method: 'POST' })
      setRevealed((current) => ({ ...current, [token.id]: key }))
    } catch (error) {
      onResult({ message: `获取明文 Key 失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false })
    } finally {
      setRevealingId(null)
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const name = form.name.trim()
      if (!name) throw new Error('令牌名称不能为空')
      let expired_time = -1
      if (!form.never_expire) {
        const ms = new Date(form.expire_at).getTime()
        if (!Number.isFinite(ms)) throw new Error('请选择有效的到期时间')
        expired_time = Math.floor(ms / 1000)
      }
      const body: Record<string, unknown> = { name, unlimited: form.unlimited, expired_time }
      if (!form.unlimited) {
        const quota = form.quota_usd.trim() ? Number(form.quota_usd) : 0
        if (!Number.isFinite(quota) || quota < 0) throw new Error('额度必须是非负数字')
        body.quota_usd = quota
      }
      body.group = form.group.trim()
      if (editingId !== null) {
        body.status = editingStatus
        if (editingPreserved) {
          body.model_limits_enabled = editingPreserved.model_limits_enabled
          body.model_limits = editingPreserved.model_limits
          body.allow_ips = editingPreserved.allow_ips
          body.cross_group_retry = editingPreserved.cross_group_retry
        }
        return api(`/api/providers/${providerId}/newapi/tokens/${editingId}`, { method: 'PUT', body: JSON.stringify(body) })
      }
      return api(`/api/providers/${providerId}/newapi/tokens`, { method: 'POST', body: JSON.stringify(body) })
    },
    onSuccess: () => {
      onResult({ message: editingId !== null ? '令牌已更新' : '令牌已创建', ok: true })
      setFormOpen(false); setEditingId(null); setEditingPreserved(null); setForm({ ...EMPTY_TOKEN_FORM })
      invalidateTokens()
    },
    onError: (error) => onResult({ message: `保存失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false }),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 1 | 2 }) =>
      api(`/api/providers/${providerId}/newapi/tokens/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),
    onSuccess: invalidateTokens,
    onError: (error) => onResult({ message: `状态更新失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api(`/api/providers/${providerId}/newapi/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => { onResult({ message: '令牌已删除', ok: true }); invalidateTokens() },
    onError: (error) => onResult({ message: `删除失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false }),
  })

  const importMutation = useMutation({
    mutationFn: (tokens: Array<{ id: number; name: string }>) =>
      api<{ added: number; skipped: number; capped: number; pool_size: number }>(`/api/providers/${providerId}/newapi/tokens/import`, { method: 'POST', body: JSON.stringify({ tokens }) }),
    onSuccess: (data) => {
      setSelected(new Set())
      const cappedNote = data.capped > 0 ? `，超 100 上限跳过 ${data.capped}` : ''
      onResult({ message: `导入完成：新增 ${data.added}，跳过 ${data.skipped}${cappedNote}，本地 Key 池共 ${data.pool_size} 个`, ok: true })
      onPoolChanged()
    },
    onError: (error) => onResult({ message: `导入失败：${error instanceof Error ? error.message : 'unknown'}`, ok: false }),
  })

  function openCreate() {
    setEditingId(null); setEditingPreserved(null); setForm({ ...EMPTY_TOKEN_FORM }); setFormOpen(true)
  }

  function openEdit(token: NewApiToken) {
    setEditingId(token.id)
    setEditingStatus(token.status === 1 ? 1 : 2)
    setEditingPreserved({ model_limits_enabled: token.model_limits_enabled, model_limits: token.model_limits, allow_ips: token.allow_ips, cross_group_retry: token.cross_group_retry })
    setForm({
      name: token.name,
      unlimited: token.unlimited,
      quota_usd: token.unlimited ? '' : String(token.remain_usd ?? 0),
      never_expire: token.expired_time <= 0,
      expire_at: token.expired_time > 0 ? toDatetimeLocal(token.expired_time) : '',
      group: token.group,
    })
    setFormOpen(true)
  }

  function toggleSelect(id: number) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedTokens = items.filter((token) => selected.has(token.id))

  return (
    <Dialog open={!!provider} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Token 管理</DialogTitle>
          <DialogDescription>
            {provider ? `「${provider.name}」上游控制台令牌：共 ${total} 个。可创建、启停、删除，或多选导入本地 Key 池。` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={openCreate}><Plus className="h-3.5 w-3.5" /> 新建令牌</Button>
            <Button size="sm" variant="outline" onClick={() => tokensQuery.refetch()} disabled={tokensQuery.isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${tokensQuery.isFetching ? 'animate-spin' : ''}`} /> 刷新
            </Button>
          </div>
          {items.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <button className="hover:underline" onClick={() => setSelected(new Set(items.map((token) => token.id)))}>全选本页</button>
              <button className="hover:underline" onClick={() => setSelected(new Set())}>清空</button>
            </div>
          )}
        </div>

        {formOpen && (
          <div className="shrink-0 space-y-3 rounded-md border bg-muted/30 p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>名称</Label>
                <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="令牌名称" />
              </div>
              <div className="space-y-1.5">
                <Label>分组（可选）</Label>
                <Input value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} placeholder="留空为默认分组" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.unlimited} onCheckedChange={(checked) => setForm({ ...form, unlimited: checked })} /> 无限额度
              </label>
              {!form.unlimited && (
                <div className="flex items-center gap-2">
                  <Label className="whitespace-nowrap">额度（USD）</Label>
                  <Input type="number" min="0" step="0.01" className="h-8 w-28" value={form.quota_usd} onChange={(event) => setForm({ ...form, quota_usd: event.target.value })} placeholder="0" />
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.never_expire} onCheckedChange={(checked) => setForm({ ...form, never_expire: checked })} /> 永不过期
              </label>
              {!form.never_expire && (
                <Input type="datetime-local" className="h-8 w-56" value={form.expire_at} onChange={(event) => setForm({ ...form, expire_at: event.target.value })} />
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => { setFormOpen(false); setEditingId(null); setEditingPreserved(null) }}>取消</Button>
              <Button size="sm" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {editingId !== null ? '保存修改' : '创建'}
              </Button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {tokensQuery.isError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              <span className="min-w-0 break-words">令牌列表加载失败：{tokensQuery.error instanceof Error ? tokensQuery.error.message : 'unknown'}</span>
              <Button size="sm" variant="outline" onClick={() => tokensQuery.refetch()}><RefreshCw className="h-3.5 w-3.5" /> 重试</Button>
            </div>
          ) : tokensQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 正在加载令牌...</div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table className="data-table">
                <TableHeader><TableRow>
                  <TableHead className="w-10 pl-3"></TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead className="whitespace-nowrap">剩余 / 已用</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="whitespace-nowrap">到期</TableHead>
                  <TableHead className="pr-4 text-right">操作</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {items.map((token) => {
                    const shownKey = revealed[token.id] ?? token.key
                    const isRevealed = revealed[token.id] !== undefined
                    return (
                      <TableRow key={token.id} className={selected.has(token.id) ? 'bg-muted/50' : undefined}>
                        <TableCell className="pl-3"><Checkbox checked={selected.has(token.id)} onCheckedChange={() => toggleSelect(token.id)} aria-label={`选择 ${token.name}`} /></TableCell>
                        <TableCell className="font-medium">
                          <div className="truncate max-w-[120px]" title={token.name}>{token.name}</div>
                          {token.group && <div className="text-[11px] font-normal text-muted-foreground">{token.group}</div>}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <span className="max-w-[150px] truncate font-mono text-xs" title={shownKey}>{shownKey}</span>
                            <Button variant="ghost" size="icon" className="icon-button h-6 w-6 shrink-0" title={isRevealed ? '隐藏明文' : '显示明文 Key'} aria-label={`显示或隐藏 ${token.name} 的明文 Key`} disabled={revealingId === token.id} onClick={() => void handleReveal(token)}>
                              {revealingId === token.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                            {isRevealed && <Button variant="ghost" size="icon" className="icon-button h-6 w-6 shrink-0" title="复制明文 Key" aria-label={`复制 ${token.name} 的明文 Key`} onClick={() => void copyText(shownKey).then((done) => onResult({ message: done ? '已复制明文 Key' : '复制失败', ok: done }))}><Copy className="h-3.5 w-3.5" /></Button>}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {token.unlimited
                            ? <span className="flex items-center gap-1"><InfinityIcon className="h-3.5 w-3.5" /> 已用 ${token.used_usd.toFixed(2)}</span>
                            : <>${(token.remain_usd ?? 0).toFixed(2)} <span className="text-muted-foreground">/ ${token.used_usd.toFixed(2)}</span></>}
                        </TableCell>
                        <TableCell>
                          <Switch checked={token.status === 1} disabled={toggleMutation.isPending && toggleMutation.variables?.id === token.id} onCheckedChange={(checked) => toggleMutation.mutate({ id: token.id, status: checked ? 1 : 2 })} aria-label={`切换 ${token.name} 启用状态`} />
                          {token.status !== 1 && token.status !== 2 && <Badge variant="outline" className="ml-1">异常</Badge>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{expiryLabel(token.expired_time)}</TableCell>
                        <TableCell className="pr-4">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="icon" className="icon-button" title="编辑" aria-label={`编辑 ${token.name}`} onClick={() => openEdit(token)}><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button variant="ghost" size="icon" className="icon-button hover:text-destructive" title="删除" aria-label={`删除 ${token.name}`} onClick={() => { void (async () => { if (await confirm({ title: '删除令牌？', description: `确定删除上游令牌「${token.name}」？此操作不可撤销，且不影响本地 Key 池已导入的副本。`, confirmLabel: '删除', destructive: true })) deleteMutation.mutate(token.id) })() }}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {!items.length && <TableRow><TableCell colSpan={7} className="h-16 text-center text-xs text-muted-foreground">暂无令牌，点击「新建令牌」创建。</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Button variant="ghost" size="icon" className="icon-button h-7 w-7" disabled={page <= 1 || tokensQuery.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))} aria-label="上一页"><ChevronLeft className="h-4 w-4" /></Button>
            <span>第 {page} / {totalPages} 页</span>
            <Button variant="ghost" size="icon" className="icon-button h-7 w-7" disabled={page >= totalPages || tokensQuery.isFetching} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} aria-label="下一页"><ChevronRight className="h-4 w-4" /></Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
            <Button disabled={selectedTokens.length === 0 || importMutation.isPending} onClick={() => importMutation.mutate(selectedTokens.map((token) => ({ id: token.id, name: token.name })))}>
              {importMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} 导入 {selectedTokens.length} 个到 Key 池
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
