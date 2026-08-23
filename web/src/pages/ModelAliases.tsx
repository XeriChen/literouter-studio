import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Brain, Check, ChevronDown, ChevronRight, Copy, GripVertical, ListChecks, Loader2, Pencil, Plus, Power, Search, Trash2, X } from 'lucide-react'
import { api } from '@/api/client'
import type { AliasGroup, AliasTarget, ModelAlias, Provider, ProviderModel, ThinkingConfig } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type Protocol = 'openai' | 'anthropic'

function keyOf(a: Pick<ModelAlias, 'protocol' | 'alias_name'>): string {
  return `${a.protocol}/${a.alias_name}`
}

interface ThinkingFormState {
  mode: 'off' | 'override' | 'default'
  anthropicType: 'enabled' | 'disabled'
  budget: string
  effort: string
}

const emptyThinkingForm: ThinkingFormState = { mode: 'off', anthropicType: 'enabled', budget: '4096', effort: '' }

function parseThinkingForm(thinkingJson: string | null): ThinkingFormState {
  if (!thinkingJson) return emptyThinkingForm
  try {
    const config = JSON.parse(thinkingJson) as ThinkingConfig
    if (config.mode !== 'override' && config.mode !== 'default') return emptyThinkingForm
    const value = config.value
    if (value !== null && typeof value === 'object') {
      const thinking = value as { type?: string; budget_tokens?: unknown }
      return { mode: config.mode, anthropicType: thinking.type === 'disabled' ? 'disabled' : 'enabled', budget: String(thinking.budget_tokens ?? 4096), effort: '' }
    }
    return { mode: config.mode, anthropicType: 'enabled', budget: '4096', effort: typeof value === 'string' ? value : '' }
  } catch {
    return emptyThinkingForm
  }
}

function buildThinking(form: ThinkingFormState, protocol: Protocol): { config: ThinkingConfig | null; error?: string } {
  if (form.mode === 'off') return { config: null }
  let value: unknown
  if (protocol === 'anthropic') {
    if (form.anthropicType === 'disabled') {
      value = { type: 'disabled' }
    } else {
      const budget = Number(form.budget)
      if (!Number.isInteger(budget) || budget < 1024) return { config: null, error: 'budget_tokens 需为 ≥1024 的整数' }
      value = { type: 'enabled', budget_tokens: budget }
    }
  } else {
    const effort = form.effort.trim()
    if (!effort) return { config: null, error: 'reasoning_effort 不能为空' }
    value = effort
  }
  return { config: { mode: form.mode, value } }
}

function thinkingBadge(thinkingJson: string | null): string | null {
  try {
    if (!thinkingJson) return null
    const config = JSON.parse(thinkingJson) as ThinkingConfig
    return config.mode === 'override' ? '思考·覆盖' : config.mode === 'default' ? '思考·默认' : null
  } catch {
    return null
  }
}

function ThinkingFields({ protocol, form, onChange }: { protocol: Protocol; form: ThinkingFormState; onChange: (form: ThinkingFormState) => void }) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1.5">
        <Label>思考等级</Label>
        <Select value={form.mode} onValueChange={(value) => onChange({ ...form, mode: value as ThinkingFormState['mode'] })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">不修改（原样透传）</SelectItem>
            <SelectItem value="override">强制覆盖（忽略客户端携带值）</SelectItem>
            <SelectItem value="default">仅默认值（客户端未携带时注入）</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {form.mode !== 'off' && protocol === 'anthropic' && (
        <div className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs">thinking.type</Label>
            <Select value={form.anthropicType} onValueChange={(value) => onChange({ ...form, anthropicType: value as 'enabled' | 'disabled' })}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="enabled">enabled</SelectItem>
                <SelectItem value="disabled">disabled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.anthropicType === 'enabled' && (
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label className="text-xs">budget_tokens（≥1024）</Label>
              <Input value={form.budget} inputMode="numeric" onChange={(event) => onChange({ ...form, budget: event.target.value })} />
            </div>
          )}
        </div>
      )}
      {form.mode !== 'off' && protocol === 'openai' && (
        <div className="space-y-1.5">
          <Label className="text-xs">reasoning_effort</Label>
          <Input value={form.effort} placeholder="low / medium / high / minimal / none" onChange={(event) => onChange({ ...form, effort: event.target.value })} />
        </div>
      )}
    </div>
  )
}

function TargetPanel({
  alias,
  providers,
  models,
  onAdd,
  onActivate,
  onDelete,
  onReorder,
}: {
  alias: ModelAlias
  providers: Provider[]
  models: ProviderModel[]
  onAdd: (provider_id: string, model_id: string) => void
  onActivate: (target: AliasTarget) => void
  onDelete: (target: AliasTarget) => void
  onReorder: (targets: AliasTarget[]) => void
}) {
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [dragKey, setDragKey] = useState<string | null>(null)
  const availableProviders = providers.filter((p) => p.protocol === alias.protocol && p.enabled === 1)
  const availableModels = models.filter((m) => m.provider_id === providerId && m.provider_enabled === 1 && m.enabled === 1)
  const existing = new Set(alias.targets.map((t) => `${t.provider_id}/${t.model_id}`))

  function move(target: AliasTarget, over: AliasTarget) {
    if (target.id === over.id) return
    const next = [...alias.targets]
    const from = next.findIndex((item) => item.id === target.id)
    const to = next.findIndex((item) => item.id === over.id)
    if (from < 0 || to < 0) return
    const [item] = next.splice(from, 1)
    if (!item) return
    next.splice(to, 0, item)
    onReorder(next)
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold">候选目标（按优先级排序，当前只使用一个）</div>
        <Badge variant="secondary">{alias.targets.length} 个</Badge>
      </div>
      <div className="space-y-1.5">
        {alias.targets.map((target) => {
          const available = target.provider_enabled === 1 && target.target_enabled === 1
          return (
            <div
              key={target.id}
              draggable
              onDragStart={() => setDragKey(String(target.id))}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragKey) move(alias.targets.find((item) => String(item.id) === dragKey) ?? target, target)
                setDragKey(null)
              }}
              className={`flex items-center gap-2 rounded border bg-card px-2.5 py-2 text-xs ${target.active ? 'border-primary/50' : ''}`}
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground" />
              <span className="w-5 text-center font-mono text-muted-foreground">{target.priority + 1}</span>
              <input
                type="radio"
                checked={!!target.active}
                disabled={!available}
                onChange={() => onActivate(target)}
                title="设为当前目标"
              />
              <span className="min-w-0 flex-1 truncate font-mono">{target.provider_name} / {target.model_id}</span>
              {target.active && <Badge variant="outline">当前</Badge>}
              {!target.provider_enabled && <Badge variant="destructive">Provider 已禁用</Badge>}
              {target.provider_enabled === 1 && !target.target_enabled && <Badge variant="destructive">模型已禁用</Badge>}
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => onDelete(target)} title="删除候选">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )
        })}
        {!alias.targets.length && <p className="py-2 text-xs text-muted-foreground">暂无候选目标，映射当前不可调用。</p>}
      </div>
      <div className="flex items-end gap-2 border-t pt-3">
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-xs">Provider</Label>
          <Select value={providerId} onValueChange={(value) => { setProviderId(value); setModelId('') }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="选择 Provider" /></SelectTrigger>
            <SelectContent>{availableProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-xs">模型</Label>
          <Select value={modelId} onValueChange={setModelId} disabled={!providerId}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="选择模型" /></SelectTrigger>
            <SelectContent>{availableModels.map((model) => <SelectItem key={model.model_id} value={model.model_id} disabled={existing.has(`${model.provider_id}/${model.model_id}`)}>{model.display_name || model.model_id}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="outline" disabled={!providerId || !modelId || existing.has(`${providerId}/${modelId}`)} onClick={() => { onAdd(providerId, modelId); setModelId('') }}><Plus className="h-3.5 w-3.5" /> 添加</Button>
      </div>
    </div>
  )
}

export default function ModelAliases() {
  const qc = useQueryClient()
  const [protocol, setProtocol] = useState<'all' | Protocol>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [addOpen, setAddOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupForm, setGroupForm] = useState<{ protocol: Protocol; name: string }>({ protocol: 'openai', name: '' })
  const [addForm, setAddForm] = useState<{ protocol: Protocol; alias_name: string; group_id: string; provider_id: string; model_id: string }>({ protocol: 'openai', alias_name: '', group_id: '', provider_id: '', model_id: '' })
  const [addThinking, setAddThinking] = useState<ThinkingFormState>(emptyThinkingForm)
  const [thinkingFor, setThinkingFor] = useState<ModelAlias | null>(null)
  const [thinkingForm, setThinkingForm] = useState<ThinkingFormState>(emptyThinkingForm)
  const [renaming, setRenaming] = useState<{ kind: 'alias' | 'group'; protocol: Protocol; id: string; name: string } | null>(null)
  const [toasts, setToasts] = useState<Array<{ id: number; ok: boolean; message: string }>>([])
  const [quickTestId, setQuickTestId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null)
  const [dragAliasKey, setDragAliasKey] = useState<string | null>(null)
  const [selectionMode, setSelectionMode] = useState<Set<string>>(new Set())
  const toastId = useRef(0)

  function toast(ok: boolean, message: string) {
    const id = ++toastId.current
    setToasts((previous) => [...previous, { id, ok, message }])
    setTimeout(() => setToasts((previous) => previous.filter((item) => item.id !== id)), 4000)
  }

  const aliases = useQuery({ queryKey: ['aliases'], queryFn: () => api<ModelAlias[]>('/api/aliases') })
  const groups = useQuery({ queryKey: ['alias-groups'], queryFn: () => api<AliasGroup[]>('/api/alias-groups') })
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('/api/providers') })
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ProviderModel[]>('/api/models') })

  const visibleProtocols = protocol === 'all' ? (['openai', 'anthropic'] as Protocol[]) : [protocol]
  const rows = useMemo(() => aliases.data ?? [], [aliases.data])
  const visibleRows = rows.filter((row) => protocol === 'all' || row.protocol === protocol)
  const filteredRows = useMemo(() => {
    if (!debouncedSearch.trim()) return visibleRows
    const q = debouncedSearch.trim().toLowerCase()
    return visibleRows.filter((row) =>
      row.alias_name.toLowerCase().includes(q) ||
      (row.provider_name ?? '').toLowerCase().includes(q) ||
      (row.model_id ?? '').toLowerCase().includes(q)
    )
  }, [visibleRows, debouncedSearch])

  useEffect(() => {
    if (!aliases.data) return
    const existingKeys = new Set(aliases.data.map((a) => keyOf(a)))
    setSelected((current) => {
      const next = new Set([...current].filter((k) => existingKeys.has(k)))
      return next.size === current.size ? current : next
    })
  }, [aliases.data])

  const selectedAliases = useMemo(() => {
    return filteredRows.filter((row) => selected.has(keyOf(row)))
  }, [filteredRows, selected])

  const selectedProtocol = selectedAliases.length > 0
    && new Set(selectedAliases.map((a) => a.protocol)).size === 1
    ? selectedAliases[0]?.protocol ?? null
    : null

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['aliases'] })
    qc.invalidateQueries({ queryKey: ['alias-groups'] })
    qc.invalidateQueries({ queryKey: ['models'] })
  }

  const addAliasMutation = useMutation({
    mutationFn: () => {
      const built = buildThinking(addThinking, addForm.protocol)
      if (built.error) return Promise.reject(new Error(built.error))
      return api('/api/aliases', { method: 'POST', body: JSON.stringify({ ...addForm, group_id: addForm.group_id || null, alias_name: addForm.alias_name.trim(), thinking: built.config ?? undefined }) })
    },
    onSuccess: () => { setAddOpen(false); setAddForm({ protocol: 'openai', alias_name: '', group_id: '', provider_id: '', model_id: '' }); setAddThinking(emptyThinkingForm); invalidate(); toast(true, '映射创建成功') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '创建失败'),
  })
  const patchAliasMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/aliases', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); toast(true, '映射已更新') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '更新失败'),
  })
  const deleteAliasMutation = useMutation({
    mutationFn: (a: ModelAlias) => api('/api/aliases', { method: 'DELETE', body: JSON.stringify({ protocol: a.protocol, alias_name: a.alias_name }) }),
    onSuccess: () => { invalidate(); toast(true, '映射已删除') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '删除失败'),
  })
  const addGroupMutation = useMutation({
    mutationFn: () => api('/api/alias-groups', { method: 'POST', body: JSON.stringify({ ...groupForm, name: groupForm.name.trim() }) }),
    onSuccess: () => { setGroupOpen(false); setGroupForm({ protocol: 'openai', name: '' }); invalidate(); toast(true, '分组创建成功') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '创建分组失败'),
  })
  const groupActionMutation = useMutation({
    mutationFn: ({ action, group }: { action: 'clear' | 'delete'; group: AliasGroup }) => {
      const path = action === 'clear' ? '/api/alias-groups/batch-delete' : '/api/alias-groups'
      return api(path, { method: action === 'delete' ? 'DELETE' : 'POST', body: JSON.stringify({ protocol: group.protocol, group_id: group.id }) })
    },
    onSuccess: (_data, variables) => { invalidate(); toast(true, variables.action === 'clear' ? '分组内映射已清空' : '分组已删除') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '分组操作失败'),
  })
  const targetMutation = useMutation({
    mutationFn: ({ method, path, body }: { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body: unknown }) => api(path, { method, body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); toast(true, '候选目标已更新') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '候选目标操作失败'),
  })
  const batchMoveGroupMutation = useMutation({
    mutationFn: async ({ items, groupId }: { items: ModelAlias[]; groupId: string | null }) => {
      await Promise.all(items.map((a) =>
        api('/api/aliases', { method: 'PATCH', body: JSON.stringify({ protocol: a.protocol, alias_name: a.alias_name, group_id: groupId }) })
      ))
    },
    onSuccess: () => { setSelected(new Set()); setSelectionMode(new Set()); invalidate(); toast(true, '批量移动分组完成') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '批量移动失败'),
  })
  const batchDeleteMutation = useMutation({
    mutationFn: async (items: ModelAlias[]) => {
      await Promise.all(items.map((a) =>
        api('/api/aliases', { method: 'DELETE', body: JSON.stringify({ protocol: a.protocol, alias_name: a.alias_name }) })
      ))
    },
    onSuccess: () => { setSelected(new Set()); setSelectionMode(new Set()); invalidate(); toast(true, '批量删除完成') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '批量删除失败'),
  })
  const batchSetEnabledMutation = useMutation({
    mutationFn: async ({ items, enabled }: { items: ModelAlias[]; enabled: number }) => {
      await Promise.all(items.map((a) =>
        api('/api/aliases', { method: 'PATCH', body: JSON.stringify({ protocol: a.protocol, alias_name: a.alias_name, enabled }) })
      ))
    },
    onSuccess: (_data, { enabled }) => { setSelected(new Set()); setSelectionMode(new Set()); invalidate(); toast(true, enabled ? '批量启用完成' : '批量禁用完成') },
    onError: (error) => toast(false, error instanceof Error ? error.message : '批量更新失败'),
  })

  const filteredGroups = (groups.data ?? []).filter((group) => protocol === 'all' || group.protocol === protocol)
  function rowsFor(protocolValue: Protocol, groupId: string | null) {
    return filteredRows.filter((row) => row.protocol === protocolValue && row.group_id === groupId)
  }

  function openRename(kind: 'alias' | 'group', protocolValue: Protocol, id: string, name: string) {
    setRenaming({ kind, protocol: protocolValue, id, name })
  }

  function openThinking(alias: ModelAlias) {
    setThinkingFor(alias)
    setThinkingForm(parseThinkingForm(alias.thinking_json))
  }

  function saveThinking() {
    if (!thinkingFor) return
    const built = buildThinking(thinkingForm, thinkingFor.protocol)
    if (built.error) { toast(false, built.error); return }
    patchAliasMutation.mutate(
      { protocol: thinkingFor.protocol, alias_name: thinkingFor.alias_name, thinking: built.config },
      { onSuccess: () => setThinkingFor(null) },
    )
  }

  function saveRename() {
    if (!renaming || !renaming.name.trim()) return
    if (renaming.kind === 'alias') {
      patchAliasMutation.mutate({ protocol: renaming.protocol, alias_name: renaming.id, new_alias_name: renaming.name.trim() }, { onSuccess: () => setRenaming(null) })
    } else {
      api('/api/alias-groups', { method: 'PATCH', body: JSON.stringify({ protocol: renaming.protocol, group_id: renaming.id, name: renaming.name.trim() }) }).then(() => { setRenaming(null); invalidate(); toast(true, '分组名称已更新') }).catch((error) => toast(false, error instanceof Error ? error.message : '重命名失败'))
    }
  }

  function renderGroup(protocolValue: Protocol, group: AliasGroup | null) {
    const groupRows = rowsFor(protocolValue, group?.id ?? null)
    const groupKey = `${protocolValue}/${group?.id ?? 'ungrouped'}`
    const groupStateKey = `group:${groupKey}`
    const isOpen = !expanded.has(groupStateKey)
    const toggle = () => setExpanded((previous) => { const next = new Set(previous); if (next.has(groupStateKey)) next.delete(groupStateKey); else next.add(groupStateKey); return next })
    const isActive = selectionMode.has(groupKey)
    const groupSelectedCount = groupRows.filter((r) => selected.has(keyOf(r))).length
    const allGroupSelected = groupRows.length > 0 && groupSelectedCount === groupRows.length
    const cols = isActive ? 8 : 7
    const canDrop = dragAliasKey !== null && protocolValue === dragAliasKey.split('/')[0]
    const isDragOver = canDrop && dragOverGroupKey === groupKey
    return (
      <Card
        key={groupKey}
        className={`console-surface shadow-none transition-shadow ${isDragOver ? 'ring-2 ring-primary/50' : ''}`}
        onDragOver={(e) => { if (canDrop) { e.preventDefault(); setDragOverGroupKey(groupKey) } }}
        onDragLeave={() => { if (dragOverGroupKey === groupKey) setDragOverGroupKey(null) }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOverGroupKey(null)
          if (!dragAliasKey) return
          const [dragProtocol, ...nameParts] = dragAliasKey.split('/')
          const dragAliasName = nameParts.join('/')
          if (dragProtocol !== protocolValue) return
          const dragAlias = rows.find((r) => r.protocol === dragProtocol && r.alias_name === dragAliasName)
          if (!dragAlias || dragAlias.group_id === (group?.id ?? null)) return
          patchAliasMutation.mutate({ protocol: dragProtocol, alias_name: dragAliasName, group_id: group?.id ?? null })
        }}
      >
        <CardHeader className="flex-row items-center justify-between border-b border-foreground/10 px-5 py-3">
          <button className="flex min-w-0 items-center gap-2 text-left" onClick={toggle}>
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <CardTitle className="truncate text-sm font-medium">{group?.name ?? '未分组'}</CardTitle>
            <Badge variant="secondary">{groupRows.length}</Badge>
            {group && <Badge variant="outline">{group.enabled_count} 已启用</Badge>}
          </button>
          <div className="flex items-center gap-1">
            <Button size="icon" variant={isActive ? 'secondary' : 'ghost'} className="h-8 w-8" aria-label={`切换 ${group?.name ?? '未分组'} 多选模式`} onClick={() => {
              if (selectionMode.has(groupKey)) {
                setSelectionMode((prev) => { const next = new Set(prev); next.delete(groupKey); return next })
                setSelected((prev) => { const next = new Set(prev); groupRows.forEach((r) => next.delete(keyOf(r))); return next })
              } else {
                setSelectionMode((prev) => new Set(prev).add(groupKey))
              }
            }}>
              <ListChecks className="h-4 w-4" />
            </Button>
            {group && <>
              <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`清空分组「${group.name}」内的 ${groupRows.length} 个映射？`)) groupActionMutation.mutate({ action: 'clear', group }) }}><Trash2 className="h-3.5 w-3.5" /> 清空映射</Button>
              <Button size="sm" variant="ghost" onClick={() => openRename('group', group.protocol, group.id, group.name)}><Pencil className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm(`删除分组「${group.name}」及其全部映射？`)) groupActionMutation.mutate({ action: 'delete', group }) }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </>}
          </div>
        </CardHeader>
        {isOpen && <CardContent className="p-0">
          <Table className="data-table">
            <TableHeader><TableRow>
              {isActive && <TableHead className="w-9 pl-4"><Checkbox checked={allGroupSelected ? true : groupSelectedCount > 0 ? 'indeterminate' : false} onCheckedChange={() => { if (allGroupSelected) setSelected((prev) => { const next = new Set(prev); groupRows.forEach((r) => next.delete(keyOf(r))); return next }); else setSelected((prev) => { const next = new Set(prev); groupRows.forEach((r) => next.add(keyOf(r))); return next }) }} aria-label="选择当前分组全部映射" /></TableHead>}
              <TableHead className="w-9 pl-0"><span className="sr-only">拖动排序</span></TableHead>
              <TableHead className="w-9"><span className="sr-only">展开候选</span></TableHead>
              <TableHead>映射名</TableHead>
              <TableHead>启用</TableHead>
              <TableHead>当前目标</TableHead>
              <TableHead>候选</TableHead>
              <TableHead className="pr-5 text-right">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {groupRows.map((alias) => {
                const aliasKey = keyOf(alias)
                const aliasStateKey = `alias:${aliasKey}`
                const open = expanded.has(aliasStateKey)
                const thinkingTag = thinkingBadge(alias.thinking_json)
                const activeAvailable = alias.provider_id !== null && alias.model_id !== null && alias.provider_enabled === 1 && alias.target_enabled === 1
                return <Fragment key={aliasKey}>
                  <TableRow key={aliasKey} className={selected.has(aliasKey) ? 'bg-muted/50' : ''}>
                    {isActive && <TableCell className="pl-4"><Checkbox checked={selected.has(aliasKey)} onCheckedChange={() => setSelected((prev) => { const next = new Set(prev); if (next.has(aliasKey)) next.delete(aliasKey); else next.add(aliasKey); return next })} aria-label={`选择 ${alias.alias_name}`} /></TableCell>}
                    <TableCell className="w-9 pl-0"><div
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', aliasKey); setDragAliasKey(aliasKey) }}
                      onDragEnd={() => { setDragAliasKey(null); setDragOverGroupKey(null) }}
                    ><GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground" /></div></TableCell>
                    <TableCell className="w-9"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setExpanded((previous) => { const next = new Set(previous); if (next.has(aliasStateKey)) next.delete(aliasStateKey); else next.add(aliasStateKey); return next })}>{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</Button></TableCell>
                    <TableCell><div className="flex items-center gap-2"><span className="font-mono text-xs">{alias.alias_name}</span>{thinkingTag && <Badge variant="outline">{thinkingTag}</Badge>}<button className="text-muted-foreground hover:text-foreground" title="复制" onClick={() => navigator.clipboard?.writeText(alias.alias_name).then(() => toast(true, '已复制映射名'))}><Copy className="h-3.5 w-3.5" /></button><button className="text-muted-foreground hover:text-foreground" title="重命名" onClick={() => openRename('alias', alias.protocol, alias.alias_name, alias.alias_name)}><Pencil className="h-3.5 w-3.5" /></button></div></TableCell>
                    <TableCell><label className="flex items-center gap-1.5 text-xs"><Checkbox checked={alias.enabled === 1} onCheckedChange={(checked) => patchAliasMutation.mutate({ protocol: alias.protocol, alias_name: alias.alias_name, enabled: checked ? 1 : 0 })} />{alias.enabled ? '已启用' : '已停用'}</label></TableCell>
                    <TableCell><div className="max-w-[250px] truncate text-xs">{alias.provider_name && alias.model_id ? `${alias.provider_name} / ${alias.model_id}` : '未设置目标'}</div>{!activeAvailable && <Badge variant="destructive" className="mt-1">不可调用</Badge>}</TableCell>
                    <TableCell><Badge variant="secondary">{alias.targets.length} 个</Badge></TableCell>
                    <TableCell className="pr-5"><div className="flex justify-end gap-1"><button disabled={quickTestId !== null || !activeAvailable || alias.enabled !== 1} className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40" title="快速测活" onClick={() => { if (!alias.provider_id || !alias.model_id) return; setQuickTestId(aliasKey); api<{ reply: string; latency_ms: number }>('/api/models/test', { method: 'POST', body: JSON.stringify({ provider_id: alias.provider_id, model_id: alias.model_id }) }).then((data) => toast(true, `${alias.alias_name}: ${data.reply}`)).catch((error) => toast(false, error instanceof Error ? error.message : '测活失败')).finally(() => setQuickTestId(null)) }}>{quickTestId === aliasKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}</button><Button variant="ghost" size="sm" title="思考等级" onClick={() => openThinking(alias)}><Brain className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm(`确定删除映射「${alias.alias_name}」？`)) deleteAliasMutation.mutate(alias) }}><Trash2 className="h-3.5 w-3.5" /></Button></div></TableCell>
                  </TableRow>
                  {open && <TableRow key={`${aliasKey}/targets`}><TableCell colSpan={cols} className="bg-muted/10 px-5 py-3"><TargetPanel alias={alias} providers={providers.data ?? []} models={models.data ?? []} onAdd={(provider_id, model_id) => targetMutation.mutate({ method: 'POST', path: '/api/alias-targets', body: { protocol: alias.protocol, alias_name: alias.alias_name, provider_id, model_id } })} onActivate={(target) => targetMutation.mutate({ method: 'PATCH', path: '/api/alias-targets', body: { protocol: alias.protocol, alias_name: alias.alias_name, provider_id: target.provider_id, model_id: target.model_id } })} onDelete={(target) => { if (window.confirm(`删除候选「${target.model_id}」？`)) targetMutation.mutate({ method: 'DELETE', path: '/api/alias-targets', body: { protocol: alias.protocol, alias_name: alias.alias_name, provider_id: target.provider_id, model_id: target.model_id } }) }} onReorder={(targets) => targetMutation.mutate({ method: 'POST', path: '/api/alias-targets/reorder', body: { protocol: alias.protocol, alias_name: alias.alias_name, targets: targets.map((target) => ({ provider_id: target.provider_id, model_id: target.model_id })) } })} /></TableCell></TableRow>}
                </Fragment>
              })}
              {!groupRows.length && <TableRow><TableCell colSpan={cols} className="h-20 text-center text-xs text-muted-foreground">暂无映射；可以先保留空分组。</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>}
      </Card>
    )
  }

  const addProviders = (providers.data ?? []).filter((provider) => provider.protocol === addForm.protocol && provider.enabled === 1)
  const addModels = (models.data ?? []).filter((model) => model.provider_id === addForm.provider_id && model.provider_enabled === 1 && model.enabled === 1)
  const addGroups = (groups.data ?? []).filter((group) => group.protocol === addForm.protocol)

  return <>
    {toasts.length > 0 && <div className="fixed left-1/2 top-4 z-[100] flex -translate-x-1/2 flex-col gap-2">{toasts.map((item) => <div key={item.id} className={`rounded-lg border px-4 py-2 text-sm shadow-lg ${item.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>{item.message}</div>)}</div>}
    {selectedAliases.length > 0 && <div className="fixed inset-x-3 bottom-4 z-[90] mx-auto flex max-w-fit flex-wrap items-center justify-center gap-2 rounded-lg border bg-card px-3 py-2.5 shadow-xl sm:gap-3 sm:px-5 sm:py-3">
      <span className="text-sm font-medium">已选 {selectedAliases.length} 个映射</span>
      <div className="hidden h-4 w-px bg-border sm:block" />
      <Select
        onValueChange={(groupId) => batchMoveGroupMutation.mutate({ items: selectedAliases, groupId: groupId === 'none' ? null : groupId })}
        disabled={!selectedProtocol || batchMoveGroupMutation.isPending || batchSetEnabledMutation.isPending || batchDeleteMutation.isPending}
      >
        <SelectTrigger className="h-8 w-[170px] max-w-full text-xs" aria-label="批量移动映射到分组">
          <SelectValue placeholder={selectedProtocol ? '移动到分组' : '需选择同一协议'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">未分组</SelectItem>
          {(groups.data ?? []).filter((g) => g.protocol === selectedProtocol).map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" onClick={() => batchSetEnabledMutation.mutate({ items: selectedAliases, enabled: 1 })} disabled={batchSetEnabledMutation.isPending || batchMoveGroupMutation.isPending || batchDeleteMutation.isPending}><Power className="h-3.5 w-3.5" /> 启用</Button>
      <Button size="sm" variant="outline" onClick={() => batchSetEnabledMutation.mutate({ items: selectedAliases, enabled: 0 })} disabled={batchSetEnabledMutation.isPending || batchMoveGroupMutation.isPending || batchDeleteMutation.isPending}>禁用</Button>
      <Button size="sm" variant="outline" onClick={() => { if (window.confirm(`确定删除选中的 ${selectedAliases.length} 个映射？`)) batchDeleteMutation.mutate(selectedAliases) }} disabled={batchSetEnabledMutation.isPending || batchMoveGroupMutation.isPending || batchDeleteMutation.isPending}><Trash2 className="h-3.5 w-3.5" /> 删除</Button>
      <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setSelectionMode(new Set()) }} aria-label="清除选择"><X className="h-3.5 w-3.5" /></Button>
    </div>}
    <div className="page-shell space-y-6">
      <div className="page-heading"><div><div className="eyebrow mb-2 flex items-center gap-2"><Activity className="h-3.5 w-3.5" /> 路由键</div><h1 className="page-title">模型映射</h1><p className="page-description">按协议和分组管理映射；每个映射只会使用一个当前目标。</p></div><div className="flex items-center gap-2"><div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="h-8 w-40 pl-8 text-xs" placeholder="搜索映射..." value={search} onChange={(e) => { setSearch(e.target.value); if (searchTimer.current) clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => setDebouncedSearch(e.target.value), 200) }} /></div><Select value={protocol} onValueChange={(value) => setProtocol(value as 'all' | Protocol)}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部协议</SelectItem><SelectItem value="openai">openai</SelectItem><SelectItem value="anthropic">anthropic</SelectItem></SelectContent></Select><Button size="sm" variant="outline" onClick={() => setGroupOpen(true)}><Plus className="h-4 w-4" /> 新建分组</Button><Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> 新建映射</Button></div></div>
      {visibleProtocols.map((protocolValue) => {
        const protocolGroups = filteredGroups.filter((group) => group.protocol === protocolValue)
        const hasSearch = debouncedSearch.trim().length > 0
        const visibleGroups = hasSearch ? protocolGroups.filter((group) => rowsFor(protocolValue, group.id).length > 0) : protocolGroups
        const showUngrouped = !hasSearch || rowsFor(protocolValue, null).length > 0
        return <section key={protocolValue} className="space-y-3"><div className="flex items-center gap-2"><Badge variant={protocolValue === 'openai' ? 'outline' : 'secondary'}>{protocolValue}</Badge><span className="text-xs text-muted-foreground">{filteredRows.filter((row) => row.protocol === protocolValue).length} 个映射</span></div>{visibleGroups.map((group) => renderGroup(protocolValue, group))}{showUngrouped && renderGroup(protocolValue, null)}</section>
      })}
      {!aliases.isLoading && !filteredRows.length && <Card className="console-surface"><CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">{debouncedSearch.trim() ? '没有匹配的映射。' : '还没有模型映射，可以先创建分组或映射。'}</CardContent></Card>}
    </div>

    <Dialog open={groupOpen} onOpenChange={setGroupOpen}><DialogContent><DialogHeader><DialogTitle>新建映射分组</DialogTitle><DialogDescription>分组只用于管理和列表展示，不参与代理路由。</DialogDescription></DialogHeader><div className="space-y-4 py-2"><div className="space-y-1.5"><Label>协议</Label><Select value={groupForm.protocol} onValueChange={(value) => setGroupForm({ ...groupForm, protocol: value as Protocol })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">openai</SelectItem><SelectItem value="anthropic">anthropic</SelectItem></SelectContent></Select></div><div className="space-y-1.5"><Label>分组名称</Label><Input value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} placeholder="生产环境" /></div></div><DialogFooter><Button variant="outline" onClick={() => setGroupOpen(false)}>取消</Button><Button disabled={!groupForm.name.trim() || addGroupMutation.isPending} onClick={() => addGroupMutation.mutate()}>创建</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent><DialogHeader><DialogTitle>新建模型映射</DialogTitle><DialogDescription>首个目标必须是当前已启用的 Provider 和真实模型。</DialogDescription></DialogHeader><div className="space-y-4 py-2"><div className="space-y-1.5"><Label>协议</Label><Select value={addForm.protocol} onValueChange={(value) => setAddForm({ ...addForm, protocol: value as Protocol, group_id: '', provider_id: '', model_id: '' })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">openai</SelectItem><SelectItem value="anthropic">anthropic</SelectItem></SelectContent></Select></div><div className="space-y-1.5"><Label>映射名</Label><Input value={addForm.alias_name} onChange={(event) => setAddForm({ ...addForm, alias_name: event.target.value })} placeholder="my-brain" /></div><div className="space-y-1.5"><Label>分组（可选）</Label><Select value={addForm.group_id || 'none'} onValueChange={(value) => setAddForm({ ...addForm, group_id: value === 'none' ? '' : value })}><SelectTrigger><SelectValue placeholder="未分组" /></SelectTrigger><SelectContent><SelectItem value="none">未分组</SelectItem>{addGroups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label>Provider</Label><Select value={addForm.provider_id} onValueChange={(value) => setAddForm({ ...addForm, provider_id: value, model_id: '' })}><SelectTrigger><SelectValue placeholder="选择 Provider" /></SelectTrigger><SelectContent>{addProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label>当前目标</Label><Select value={addForm.model_id} onValueChange={(value) => setAddForm({ ...addForm, model_id: value })} disabled={!addForm.provider_id}><SelectTrigger><SelectValue placeholder="选择模型" /></SelectTrigger><SelectContent>{addModels.map((model) => <SelectItem key={model.model_id} value={model.model_id}>{model.display_name || model.model_id}</SelectItem>)}</SelectContent></Select></div><ThinkingFields protocol={addForm.protocol} form={addThinking} onChange={setAddThinking} /></div><DialogFooter><Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button><Button disabled={addAliasMutation.isPending || !addForm.alias_name.trim() || !addForm.provider_id || !addForm.model_id} onClick={() => addAliasMutation.mutate()}>创建</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={thinkingFor !== null} onOpenChange={(open) => !open && setThinkingFor(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>思考等级 — {thinkingFor?.alias_name}</DialogTitle>
          <DialogDescription>仅改写请求体顶层的 {thinkingFor?.protocol === 'openai' ? 'reasoning_effort' : 'thinking'} 字段，其余字段原样透传。</DialogDescription>
        </DialogHeader>
        {thinkingFor && <ThinkingFields protocol={thinkingFor.protocol} form={thinkingForm} onChange={setThinkingForm} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => setThinkingFor(null)}>取消</Button>
          <Button disabled={patchAliasMutation.isPending} onClick={saveThinking}><Check className="h-4 w-4" /> 保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}><DialogContent><DialogHeader><DialogTitle>{renaming?.kind === 'group' ? '重命名分组' : '重命名映射'}</DialogTitle></DialogHeader><Input autoFocus value={renaming?.name ?? ''} onChange={(event) => renaming && setRenaming({ ...renaming, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') saveRename(); if (event.key === 'Escape') setRenaming(null) }} /><DialogFooter><Button variant="outline" onClick={() => setRenaming(null)}>取消</Button><Button disabled={!renaming?.name.trim()} onClick={saveRename}><Check className="h-4 w-4" /> 保存</Button></DialogFooter></DialogContent></Dialog>
  </>
}
