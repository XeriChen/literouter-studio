import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Brain, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Eraser, FolderInput, GitMerge, GripVertical, ListChecks, Loader2, Pencil, Plus, Power, Search, TextCursorInput, Trash2, X } from 'lucide-react'
import { api } from '@/api/client'
import type { AliasGroup, AliasTarget, ModelAlias, Provider, ProviderModel, ThinkingConfig } from '@/api/types'
import { useBottomInset } from '@/hooks/useBottomInset'
import { SearchableSelect } from '@/components/searchable-select'
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

const openaiEffortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const

interface ThinkingFormState {
  mode: 'off' | 'override' | 'default'
  anthropicType: 'enabled' | 'disabled'
  budget: string
  effort: string
}

const emptyThinkingForm: ThinkingFormState = { mode: 'off', anthropicType: 'enabled', budget: '4096', effort: 'medium' }

function parseThinkingForm(thinkingJson: string | null): ThinkingFormState {
  if (!thinkingJson) return emptyThinkingForm
  try {
    const config = JSON.parse(thinkingJson) as ThinkingConfig
    if (config.mode !== 'override' && config.mode !== 'default') return emptyThinkingForm
    const value = config.value
    if (value !== null && typeof value === 'object') {
      const thinking = value as { type?: string; budget_tokens?: unknown }
      return { mode: config.mode, anthropicType: thinking.type === 'disabled' ? 'disabled' : 'enabled', budget: String(thinking.budget_tokens ?? 4096), effort: 'medium' }
    }
    return { mode: config.mode, anthropicType: 'enabled', budget: '4096', effort: typeof value === 'string' && value ? value : 'medium' }
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
    if (!(openaiEffortLevels as readonly string[]).includes(effort)) return { config: null, error: `reasoning_effort 仅支持 ${openaiEffortLevels.join(' / ')}` }
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

function parseThinkingConfig(thinkingJson: string | null): ThinkingConfig | null {
  if (!thinkingJson) return null
  try {
    const config = JSON.parse(thinkingJson) as ThinkingConfig
    return config.mode === 'override' || config.mode === 'default' ? config : null
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
          <Select value={form.effort || 'medium'} onValueChange={(value) => onChange({ ...form, effort: value })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {openaiEffortLevels.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
            </SelectContent>
          </Select>
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
  // 搜索覆盖同协议全部已启用 Provider 的真实模型；选中后回填上方 Provider 与模型
  const searchableModels = models.filter((m) => m.protocol === alias.protocol && m.provider_enabled === 1 && m.enabled === 1)
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

  function moveStep(index: number, direction: 'up' | 'down') {
    const toIndex = direction === 'up' ? index - 1 : index + 1
    if (toIndex < 0 || toIndex >= alias.targets.length) return
    const next = [...alias.targets]
    const [item] = next.splice(index, 1)
    if (!item) return
    next.splice(toIndex, 0, item)
    onReorder(next)
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold">候选目标（按优先级排序，当前只使用一个）</div>
        <Badge variant="secondary">{alias.targets.length} 个</Badge>
      </div>
      <div className="space-y-1.5">
        {alias.targets.map((target, idx) => {
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
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={idx === 0}
                  onClick={() => moveStep(idx, 'up')}
                  title="提高优先级"
                  aria-label="提高优先级"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={idx === alias.targets.length - 1}
                  onClick={() => moveStep(idx, 'down')}
                  title="降低优先级"
                  aria-label="降低优先级"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => onDelete(target)} title="删除候选" aria-label="删除候选">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )
        })}
        {!alias.targets.length && <p className="py-2 text-xs text-muted-foreground">暂无候选目标，映射当前不可调用。</p>}
      </div>
      <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-xs">Provider</Label>
          <Select value={providerId} onValueChange={(value) => { setProviderId(value); setModelId('') }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="选择 Provider" /></SelectTrigger>
            <SelectContent>{availableProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-xs">模型</Label>
          <SearchableSelect
            value={providerId && modelId ? `${providerId}/${modelId}` : ''}
            onValueChange={(_value, option) => {
              if (!option.meta) return
              setProviderId(option.meta.provider_id)
              setModelId(option.meta.model_id)
            }}
            className="h-8 text-xs"
            ariaLabel="模型"
            placeholder="搜索并选择模型"
            searchPlaceholder="模糊搜索真实模型…"
            emptyText="没有匹配的真实模型"
            options={searchableModels.map((model) => ({
              value: `${model.provider_id}/${model.model_id}`,
              label: model.display_name || model.model_id,
              keywords: [model.model_id, ...(model.display_name ? [model.display_name] : []), model.provider_name],
              group: model.provider_name,
              disabled: existing.has(`${model.provider_id}/${model.model_id}`),
              meta: model,
            }))}
          />
        </div>
        <Button size="sm" variant="outline" className="w-full shrink-0 sm:w-auto" disabled={!providerId || !modelId || existing.has(`${providerId}/${modelId}`)} onClick={() => { onAdd(providerId, modelId); setModelId('') }}><Plus className="h-3.5 w-3.5" /> 添加</Button>
      </div>
    </div>
  )
}

export default function ModelAliases() {
  const qc = useQueryClient()
  const [protocol, setProtocol] = useState<'all' | Protocol>('all')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedAliases, setExpandedAliases] = useState<Set<string>>(new Set())
  const [addOpen, setAddOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupForm, setGroupForm] = useState<{ protocol: Protocol; name: string }>({ protocol: 'openai', name: '' })
  const [addForm, setAddForm] = useState<{ protocol: Protocol; alias_name: string; group_id: string; provider_id: string; model_id: string }>({ protocol: 'openai', alias_name: '', group_id: '', provider_id: '', model_id: '' })
  const [addThinking, setAddThinking] = useState<ThinkingFormState>(emptyThinkingForm)
  const [thinkingFor, setThinkingFor] = useState<ModelAlias | null>(null)
  const [thinkingForm, setThinkingForm] = useState<ThinkingFormState>(emptyThinkingForm)
  const [renaming, setRenaming] = useState<{ protocol: Protocol; id: string; name: string } | null>(null)
  const [editing, setEditing] = useState<ModelAlias | null>(null)
  const [editForm, setEditForm] = useState<{ alias_name: string; group_id: string }>({ alias_name: '', group_id: '' })
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeMode, setMergeMode] = useState<'new' | 'existing'>('new')
  const [mergeName, setMergeName] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [mergeGroup, setMergeGroup] = useState('')
  const [mergeDeleteSources, setMergeDeleteSources] = useState(false)
  const [toasts, setToasts] = useState<Array<{ id: number; ok: boolean; message: string }>>([])
  const [quickTestId, setQuickTestId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null)
  const [dragAliasKey, setDragAliasKey] = useState<string | null>(null)
  const [selectionMode, setSelectionMode] = useState<Set<string>>(new Set())
  const [importOpen, setImportOpen] = useState<AliasGroup | null>(null)
  const [importSearch, setImportSearch] = useState('')
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set())
  const toastId = useRef(0)
  const chromeInset = useBottomInset()

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

  const forceExpand = debouncedSearch.trim().length > 0

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

  const mergeTargetName = mergeMode === 'new' ? mergeName.trim() : mergeTarget
  // 合并顺序固定为映射名字典序，避免与列表排序/点选顺序不一致导致 active 归属难以预期
  const mergeSources = useMemo(() => {
    if (!selectedProtocol) return []
    return selectedAliases
      .map((alias) => alias.alias_name)
      .filter((name) => name !== mergeTargetName)
      .sort((a, b) => a.localeCompare(b))
  }, [selectedAliases, selectedProtocol, mergeTargetName])

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
  const mergeMutation = useMutation({
    mutationFn: (body: { protocol: Protocol; sources: string[]; target_alias_name: string; group_id?: string | null; delete_sources: boolean }) => api<{
      alias: { alias_name: string; group_id: string | null }
      created: boolean
      added: number
      skipped: number
      deleted: number
    }>('/api/aliases/merge', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data, body) => {
      setMergeOpen(false)
      setSelected(new Set())
      setSelectionMode(new Set())
      setExpandedGroups((previous) => new Set(previous).add(`${body.protocol}/${data.alias.group_id ?? 'ungrouped'}`))
      setExpandedAliases((previous) => new Set(previous).add(`${body.protocol}/${data.alias.alias_name}`))
      invalidate()
      toast(true, `合并完成${data.created ? '（新建映射）' : '（并入已有映射，不改当前目标）'}：新增 ${data.added} 个候选，跳过 ${data.skipped} 个重复${data.deleted ? `，删除 ${data.deleted} 个源映射` : ''}`)
    },
    onError: (error) => toast(false, error instanceof Error ? error.message : '合并失败'),
  })
  const importToGroupMutation = useMutation({
    mutationFn: async ({ group, names }: { group: AliasGroup; names: string[] }) => {
      await Promise.all(names.map((name) =>
        api('/api/aliases', { method: 'PATCH', body: JSON.stringify({ protocol: group.protocol, alias_name: name, group_id: group.id }) })
      ))
    },
    onSuccess: (_data, { group, names }) => {
      setImportOpen(null)
      setExpandedGroups((previous) => new Set(previous).add(`${group.protocol}/${group.id}`))
      invalidate()
      toast(true, `已导入 ${names.length} 个映射至分组「${group.name}」`)
    },
    onError: (error) => { invalidate(); toast(false, error instanceof Error ? error.message : '导入映射失败') },
  })
  const cleanupInvalidMutation = useMutation({
    mutationFn: async (payload: { aliases: ModelAlias[]; targets: Array<{ protocol: Protocol; alias_name: string; provider_id: string; model_id: string }> }) => {
      await Promise.all(payload.targets.map((t) =>
        api('/api/alias-targets', { method: 'DELETE', body: JSON.stringify(t) })
      ))
      await Promise.all(payload.aliases.map((a) =>
        api('/api/aliases', { method: 'DELETE', body: JSON.stringify({ protocol: a.protocol, alias_name: a.alias_name }) })
      ))
    },
    onSuccess: (_data, payload) => {
      invalidate()
      const parts: string[] = []
      if (payload.aliases.length) parts.push(`${payload.aliases.length} 个无效映射`)
      if (payload.targets.length) parts.push(`${payload.targets.length} 个无效候选`)
      toast(true, `已清理 ${parts.join(' 与 ')}`)
    },
    onError: (error) => { invalidate(); toast(false, error instanceof Error ? error.message : '清理失败') },
  })

  const filteredGroups = (groups.data ?? []).filter((group) => protocol === 'all' || group.protocol === protocol)
  function rowsFor(protocolValue: Protocol, groupId: string | null) {
    return filteredRows.filter((row) => row.protocol === protocolValue && row.group_id === groupId)
  }

  // 无效映射：没有任何候选目标（或候选全部指向已删除的真实模型/Provider），已不可调用
  const invalidAliases = useMemo(
    () => rows.filter((row) => (protocol === 'all' || row.protocol === protocol) && row.targets.length === 0),
    [rows, protocol],
  )
  // 无效候选：指向已禁用的 Provider 或已禁用的真实模型，当前协议下不可调用
  const invalidTargets = useMemo(() => {
    const result: Array<{ protocol: Protocol; alias_name: string; provider_id: string; model_id: string }> = []
    for (const row of rows) {
      if (protocol !== 'all' && row.protocol !== protocol) continue
      for (const target of row.targets) {
        if (target.provider_enabled !== 1 || target.target_enabled !== 1) {
          result.push({ protocol: row.protocol, alias_name: row.alias_name, provider_id: target.provider_id, model_id: target.model_id })
        }
      }
    }
    return result
  }, [rows, protocol])
  const invalidTotalCount = invalidAliases.length + invalidTargets.length

  const importCandidates = useMemo(() => {
    if (!importOpen) return []
    return rows.filter((row) => row.protocol === importOpen.protocol && row.group_id !== importOpen.id)
  }, [importOpen, rows])
  const importFiltered = useMemo(() => {
    const query = importSearch.trim().toLowerCase()
    if (!query) return importCandidates
    return importCandidates.filter((row) =>
      row.alias_name.toLowerCase().includes(query) ||
      (row.group_name ?? '').toLowerCase().includes(query)
    )
  }, [importCandidates, importSearch])

  function openMerge() {
    if (!selectedProtocol) return
    setMergeMode('new')
    setMergeName('')
    setMergeTarget('')
    setMergeGroup('')
    setMergeDeleteSources(false)
    setMergeOpen(true)
  }

  function openImport(group: AliasGroup) {
    setImportOpen(group)
    setImportSearch('')
    setImportSelected(new Set())
  }

  function toggleImportSelected(aliasName: string) {
    setImportSelected((previous) => {
      const next = new Set(previous)
      if (next.has(aliasName)) next.delete(aliasName)
      else next.add(aliasName)
      return next
    })
  }

  function openRename(protocolValue: Protocol, id: string, name: string) {
    setRenaming({ protocol: protocolValue, id, name })
  }

  function openEdit(alias: ModelAlias) {
    setEditing(alias)
    setEditForm({ alias_name: alias.alias_name, group_id: alias.group_id ?? '' })
  }

  function saveEdit() {
    if (!editing || !editForm.alias_name.trim()) return
    patchAliasMutation.mutate(
      {
        protocol: editing.protocol,
        alias_name: editing.alias_name,
        new_alias_name: editForm.alias_name.trim(),
        group_id: editForm.group_id || null,
      },
      { onSuccess: () => setEditing(null) },
    )
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
    api('/api/alias-groups', { method: 'PATCH', body: JSON.stringify({ protocol: renaming.protocol, group_id: renaming.id, name: renaming.name.trim() }) }).then(() => { setRenaming(null); invalidate(); toast(true, '分组名称已更新') }).catch((error) => toast(false, error instanceof Error ? error.message : '重命名失败'))
  }

  function renderGroup(protocolValue: Protocol, group: AliasGroup | null) {
    const groupRows = rowsFor(protocolValue, group?.id ?? null)
    const groupKey = `${protocolValue}/${group?.id ?? 'ungrouped'}`
    const isOpen = forceExpand || expandedGroups.has(groupKey)
    const toggle = () => setExpandedGroups((previous) => { const next = new Set(previous); if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey); return next })
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
        <CardHeader className="items-stretch justify-between gap-2 space-y-0 border-b border-foreground/10 px-5 py-3 sm:flex-row sm:items-center">
          <button className="flex min-w-0 flex-wrap items-center gap-2 text-left" onClick={toggle} aria-expanded={isOpen}>
            {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <CardTitle className="truncate text-sm font-medium">{group?.name ?? '未分组'}</CardTitle>
            <Badge
              variant="secondary"
              className="shrink-0 font-mono whitespace-nowrap"
              title={group ? `已启用 ${group.enabled_count} / 共 ${groupRows.length}` : `共 ${groupRows.length} 个映射`}
            >
              {group ? `${group.enabled_count}/${groupRows.length}` : groupRows.length}
            </Badge>
          </button>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button
              size="icon"
              variant={isActive ? 'secondary' : 'ghost'}
              className="h-8 w-8"
              aria-label={`切换 ${group?.name ?? '未分组'} 多选模式`}
              title={`切换 ${group?.name ?? '未分组'} 多选模式`}
              onClick={() => {
                if (selectionMode.has(groupKey)) {
                  setSelectionMode((prev) => { const next = new Set(prev); next.delete(groupKey); return next })
                  setSelected((prev) => { const next = new Set(prev); groupRows.forEach((r) => next.delete(keyOf(r))); return next })
                } else {
                  setSelectionMode((prev) => new Set(prev).add(groupKey))
                }
              }}
            >
              <ListChecks className="h-4 w-4" />
            </Button>
            {group && <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={`向分组 ${group.name} 导入映射`}
                title="导入映射"
                onClick={() => openImport(group)}
              >
                <FolderInput className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={`清空分组 ${group.name} 内的映射`}
                title="清空映射"
                onClick={() => {
                  if (window.confirm(`清空分组「${group.name}」内的 ${groupRows.length} 个映射？`)) {
                    groupActionMutation.mutate({ action: 'clear', group })
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={`重命名分组 ${group.name}`}
                title="重命名分组"
                onClick={() => openRename(group.protocol, group.id, group.name)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                aria-label={`删除分组 ${group.name}`}
                title="删除分组"
                onClick={() => {
                  if (window.confirm(`删除分组「${group.name}」及其全部映射？`)) {
                    groupActionMutation.mutate({ action: 'delete', group })
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
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
                const open = expandedAliases.has(aliasKey)
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
                    <TableCell className="w-9"><Button variant="ghost" size="icon" className="h-7 w-7" aria-expanded={open} onClick={() => setExpandedAliases((previous) => { const next = new Set(previous); if (next.has(aliasKey)) next.delete(aliasKey); else next.add(aliasKey); return next })}>{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</Button></TableCell>
                    <TableCell><div className="flex items-center gap-1.5"><span className="font-mono text-xs">{alias.alias_name}</span>{thinkingTag && <Badge variant="outline">{thinkingTag}</Badge>}<button className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" title="复制" aria-label={`复制 ${alias.alias_name}`} onClick={() => navigator.clipboard?.writeText(alias.alias_name).then(() => toast(true, '已复制映射名'))}><Copy className="h-3.5 w-3.5" /></button><button className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" title="编辑" aria-label={`编辑 ${alias.alias_name}`} onClick={() => openEdit(alias)}><Pencil className="h-3.5 w-3.5" /></button></div></TableCell>
                    <TableCell><label className="flex items-center gap-1.5 text-xs"><Checkbox checked={alias.enabled === 1} onCheckedChange={(checked) => patchAliasMutation.mutate({ protocol: alias.protocol, alias_name: alias.alias_name, enabled: checked ? 1 : 0 })} />{alias.enabled ? '已启用' : '已停用'}</label></TableCell>
                    <TableCell><div className="max-w-[250px] truncate text-xs">{alias.provider_name && alias.model_id ? `${alias.provider_name} / ${alias.model_id}` : '未设置目标'}</div>{!activeAvailable && <Badge variant="destructive" className="mt-1">不可调用</Badge>}</TableCell>
                    <TableCell><Badge variant="secondary">{alias.targets.length} 个</Badge></TableCell>
                    <TableCell className="pr-5"><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" title="编辑" onClick={() => openEdit(alias)}><Pencil className="h-3.5 w-3.5" /></Button><button disabled={quickTestId !== null || !activeAvailable || alias.enabled !== 1} className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40" title="快速测活" onClick={() => { if (!alias.provider_id || !alias.model_id) return; setQuickTestId(aliasKey); api<{ reply: string; latency_ms: number }>('/api/models/test', { method: 'POST', body: JSON.stringify({ provider_id: alias.provider_id, model_id: alias.model_id, thinking: parseThinkingConfig(alias.thinking_json) ?? undefined }) }).then((data) => toast(true, `${alias.alias_name}: ${data.reply}`)).catch((error) => toast(false, error instanceof Error ? error.message : '测活失败')).finally(() => setQuickTestId(null)) }}>{quickTestId === aliasKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}</button><Button variant="ghost" size="sm" title="思考等级" onClick={() => openThinking(alias)}><Brain className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm(`确定删除映射「${alias.alias_name}」？`)) deleteAliasMutation.mutate(alias) }}><Trash2 className="h-3.5 w-3.5" /></Button></div></TableCell>
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
    {selectedAliases.length > 0 && <div style={{ bottom: `calc(${chromeInset}px + 1rem)` }} className="fixed inset-x-3 z-[90] mx-auto flex max-w-fit flex-wrap items-center justify-center gap-2 rounded-lg border bg-card px-3 py-2.5 shadow-xl sm:gap-3 sm:px-5 sm:py-3">
      <span className="text-sm font-medium">已选 {selectedAliases.length} 个映射</span>
      <div className="hidden h-4 w-px bg-border sm:block" />
      <Select
        onValueChange={(groupId) => batchMoveGroupMutation.mutate({ items: selectedAliases, groupId: groupId === 'none' ? null : groupId })}
        disabled={!selectedProtocol || batchMoveGroupMutation.isPending || mergeMutation.isPending || batchSetEnabledMutation.isPending || batchDeleteMutation.isPending}
      >
        <SelectTrigger className="h-8 w-[170px] max-w-full text-xs" aria-label="批量移动映射到分组">
          <SelectValue placeholder={selectedProtocol ? '移动到分组' : '需选择同一协议'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">未分组</SelectItem>
          {(groups.data ?? []).filter((g) => g.protocol === selectedProtocol).map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        title={selectedProtocol ? '把所选映射的候选合并到一个映射' : '需选择同一协议'}
        disabled={!selectedProtocol || mergeMutation.isPending || batchMoveGroupMutation.isPending || batchSetEnabledMutation.isPending || batchDeleteMutation.isPending}
        onClick={openMerge}
      >
        <GitMerge className="h-3.5 w-3.5" /> 合并
      </Button>
      <Button size="sm" variant="outline" onClick={() => batchSetEnabledMutation.mutate({ items: selectedAliases, enabled: 1 })} disabled={batchSetEnabledMutation.isPending || mergeMutation.isPending || batchMoveGroupMutation.isPending || batchDeleteMutation.isPending}><Power className="h-3.5 w-3.5" /> 启用</Button>
      <Button size="sm" variant="outline" onClick={() => batchSetEnabledMutation.mutate({ items: selectedAliases, enabled: 0 })} disabled={batchSetEnabledMutation.isPending || mergeMutation.isPending || batchMoveGroupMutation.isPending || batchDeleteMutation.isPending}>禁用</Button>
      <Button size="sm" variant="outline" onClick={() => { if (window.confirm(`确定删除选中的 ${selectedAliases.length} 个映射？`)) batchDeleteMutation.mutate(selectedAliases) }} disabled={batchSetEnabledMutation.isPending || mergeMutation.isPending || batchMoveGroupMutation.isPending || batchDeleteMutation.isPending}><Trash2 className="h-3.5 w-3.5" /> 删除</Button>
      <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setSelectionMode(new Set()) }} aria-label="清除选择"><X className="h-3.5 w-3.5" /></Button>
    </div>}
    <div className="page-shell space-y-6">
      <div className="page-heading"><div><div className="eyebrow mb-2 flex items-center gap-2"><Activity className="h-3.5 w-3.5" /> 路由键</div><h1 className="page-title">模型映射</h1><p className="page-description">按协议和分组管理映射；每个映射只会使用一个当前目标。</p></div><div className="flex flex-wrap items-center gap-2"><div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="h-8 w-40 pl-8 text-xs" placeholder="搜索映射..." value={search} onChange={(e) => { setSearch(e.target.value); if (searchTimer.current) clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => setDebouncedSearch(e.target.value), 200) }} /></div><Select value={protocol} onValueChange={(value) => setProtocol(value as 'all' | Protocol)}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部协议</SelectItem><SelectItem value="openai">openai</SelectItem><SelectItem value="anthropic">anthropic</SelectItem></SelectContent></Select><Button
          size="icon"
          variant="outline"
          className="relative h-8 w-8 shrink-0"
          aria-label="清理无效映射与无效候选"
          title={invalidTotalCount > 0
            ? `清理 ${[invalidAliases.length ? `${invalidAliases.length} 个无效映射` : '', invalidTargets.length ? `${invalidTargets.length} 个无效候选` : ''].filter(Boolean).join(' 与 ')}`
            : '没有需要清理的无效映射或候选'}
          onClick={() => {
            if (!invalidTotalCount) { toast(true, '没有需要清理的无效映射或候选'); return }
            const parts: string[] = []
            if (invalidAliases.length) {
              const preview = invalidAliases.slice(0, 8).map((alias) => alias.alias_name).join('、')
              const suffix = invalidAliases.length > 8 ? ` 等 ${invalidAliases.length} 个` : ''
              parts.push(`${invalidAliases.length} 个无效映射（${preview}${suffix}）`)
            }
            if (invalidTargets.length) parts.push(`${invalidTargets.length} 个不可用候选（Provider 或模型已禁用）`)
            if (window.confirm(`确定清理 ${parts.join(' 与 ')}？清理后无法自行恢复。`)) {
              cleanupInvalidMutation.mutate({ aliases: invalidAliases, targets: invalidTargets })
            }
          }}
          disabled={cleanupInvalidMutation.isPending}
        >
          <Eraser className="h-4 w-4" />
          {invalidTotalCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[9px] font-bold leading-none text-destructive-foreground">
              {invalidTotalCount}
            </span>
          )}
        </Button><Button size="sm" variant="outline" onClick={() => setGroupOpen(true)}><Plus className="h-4 w-4" /> 新建分组</Button><Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> 新建映射</Button></div></div>
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

    <Dialog open={importOpen !== null} onOpenChange={(open) => !open && setImportOpen(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导入映射到分组「{importOpen?.name}」</DialogTitle>
          <DialogDescription>把当前协议下已有映射（未分组或其他分组）移入该分组；不改变映射的候选目标与启用状态。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={importSearch} onChange={(event) => setImportSearch(event.target.value)} placeholder="模糊搜索映射名…" />
          </div>
          <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
            {importFiltered.map((alias) => (
              <label key={alias.alias_name} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
                <Checkbox checked={importSelected.has(alias.alias_name)} onCheckedChange={() => toggleImportSelected(alias.alias_name)} aria-label={`选择 ${alias.alias_name}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{alias.alias_name}</span>
                <Badge variant="secondary" className="shrink-0">{alias.group_name ?? '未分组'}</Badge>
              </label>
            ))}
            {!importFiltered.length && <p className="py-6 text-center text-xs text-muted-foreground">没有可导入的映射。</p>}
          </div>
          {importSelected.size > 0 && <p className="text-xs text-muted-foreground">已选 {importSelected.size} 个映射，导入后会从原分组移出。</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setImportOpen(null)}>取消</Button>
          <Button disabled={!importSelected.size || importToGroupMutation.isPending} onClick={() => importOpen && importToGroupMutation.mutate({ group: importOpen, names: [...importSelected] })}>
            {importToGroupMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />} 导入{importSelected.size ? ` ${importSelected.size} 个` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={addOpen} onOpenChange={setAddOpen}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>新建模型映射</DialogTitle>
          <DialogDescription>首个目标必须是当前已启用的 Provider 和真实模型。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain py-2 pr-1">
          <div className="space-y-1.5">
            <Label>协议</Label>
            <Select value={addForm.protocol} onValueChange={(value) => setAddForm({ ...addForm, protocol: value as Protocol, group_id: '', provider_id: '', model_id: '' })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">openai</SelectItem>
                <SelectItem value="anthropic">anthropic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>映射名</Label>
              {addForm.model_id && (
                <button type="button" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground" title={`映射名填入 ${addForm.model_id}`} onClick={() => setAddForm((form) => ({ ...form, alias_name: form.model_id }))}>
                  <TextCursorInput className="h-3 w-3" /> 填入真实模型名
                </button>
              )}
            </div>
            <Input value={addForm.alias_name} onChange={(event) => setAddForm({ ...addForm, alias_name: event.target.value })} placeholder="my-brain" />
          </div>
          <div className="space-y-1.5">
            <Label>分组（可选）</Label>
            <Select value={addForm.group_id || 'none'} onValueChange={(value) => setAddForm({ ...addForm, group_id: value === 'none' ? '' : value })}>
              <SelectTrigger><SelectValue placeholder="未分组" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未分组</SelectItem>
                {addGroups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={addForm.provider_id} onValueChange={(value) => setAddForm({ ...addForm, provider_id: value, model_id: '' })}>
              <SelectTrigger><SelectValue placeholder="选择 Provider" /></SelectTrigger>
              <SelectContent>
                {addProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>当前目标</Label>
            <SearchableSelect
              value={addForm.model_id}
              onValueChange={(value) => setAddForm((form) => ({ ...form, model_id: value, alias_name: form.alias_name.trim() ? form.alias_name : value }))}
              disabled={!addForm.provider_id}
              ariaLabel="当前目标"
              placeholder={addForm.provider_id ? '搜索并选择模型' : '先选择 Provider'}
              searchPlaceholder="模糊搜索真实模型…"
              emptyText="没有匹配的真实模型"
              options={addModels.map((model) => ({ value: model.model_id, label: model.display_name || model.model_id, keywords: [model.model_id, ...(model.display_name ? [model.display_name] : [])] }))}
            />
          </div>
          <ThinkingFields protocol={addForm.protocol} form={addThinking} onChange={setAddThinking} />
        </div>
        <DialogFooter className="shrink-0 border-t pt-2 sm:border-t-0">
          <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
          <Button disabled={addAliasMutation.isPending || !addForm.alias_name.trim() || !addForm.provider_id || !addForm.model_id} onClick={() => addAliasMutation.mutate()}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

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

    <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}><DialogContent><DialogHeader><DialogTitle>重命名分组</DialogTitle></DialogHeader><Input autoFocus value={renaming?.name ?? ''} onChange={(event) => renaming && setRenaming({ ...renaming, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') saveRename(); if (event.key === 'Escape') setRenaming(null) }} /><DialogFooter><Button variant="outline" onClick={() => setRenaming(null)}>取消</Button><Button disabled={!renaming?.name.trim()} onClick={saveRename}><Check className="h-4 w-4" /> 保存</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑映射</DialogTitle>
          <DialogDescription>只修改映射名与所属分组；启用开关、思考等级和候选目标请在列表中单独操作。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>映射名</Label>
            <Input autoFocus value={editForm.alias_name} onChange={(event) => setEditForm({ ...editForm, alias_name: event.target.value })} placeholder="my-brain" />
          </div>
          <div className="space-y-1.5">
            <Label>分组</Label>
            <Select value={editForm.group_id || 'none'} onValueChange={(value) => setEditForm({ ...editForm, group_id: value === 'none' ? '' : value })}>
              <SelectTrigger><SelectValue placeholder="未分组" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未分组</SelectItem>
                {(groups.data ?? []).filter((group) => group.protocol === editing?.protocol).map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
          <Button disabled={!editForm.alias_name.trim() || patchAliasMutation.isPending} onClick={saveEdit}><Check className="h-4 w-4" /> 保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>合并映射</DialogTitle>
          <DialogDescription>把所选映射的候选目标合并到一个映射名；已存在的候选会跳过，不会重复添加。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>目标映射</Label>
            <Select value={mergeMode === 'new' ? '__new__' : mergeTarget} onValueChange={(value) => {
              if (value === '__new__') { setMergeMode('new'); setMergeTarget(''); return }
              setMergeMode('existing')
              setMergeTarget(value)
            }}>
              <SelectTrigger><SelectValue placeholder="选择目标映射" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__new__">新建映射…</SelectItem>
                {(aliases.data ?? []).filter((alias) => alias.protocol === selectedProtocol).map((alias) => (
                  <SelectItem key={keyOf(alias)} value={alias.alias_name}>{alias.alias_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {mergeMode === 'new' && <>
            <div className="space-y-1.5">
              <Label>新映射名</Label>
              <Input value={mergeName} onChange={(event) => setMergeName(event.target.value)} placeholder="merged-brain" />
            </div>
            <div className="space-y-1.5">
              <Label>分组（可选）</Label>
              <Select value={mergeGroup || 'none'} onValueChange={(value) => setMergeGroup(value === 'none' ? '' : value)}>
                <SelectTrigger><SelectValue placeholder="未分组" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">未分组</SelectItem>
                  {(groups.data ?? []).filter((group) => group.protocol === selectedProtocol).map((group) => (
                    <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>}
          <div className="space-y-1.5">
            <Label>来源映射（{mergeSources.length} 个）</Label>
            <div className="flex flex-wrap gap-1.5">
              {mergeSources.map((name, index) => (
                <Badge key={name} variant={mergeMode === 'new' && index === 0 ? 'default' : 'secondary'}>
                  {name}{mergeMode === 'new' && index === 0 ? ' · 提供当前目标' : ''}
                </Badge>
              ))}
              {!mergeSources.length && <span className="text-xs text-muted-foreground">没有可合并的来源（目标映射本身不计入）。</span>}
            </div>
            <p className="text-xs text-muted-foreground">
              {mergeMode === 'new'
                ? '新建映射的当前目标取自第一个来源的当前目标，其余候选按上述顺序（映射名字典序）追加。'
                : '并入已有映射不会改变它的当前目标（不切流量）；需要切换请单独设置当前目标。'}
            </p>
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs">
            <Checkbox checked={mergeDeleteSources} onCheckedChange={(checked) => setMergeDeleteSources(checked === true)} className="mt-0.5" />
            <span>
              <span className="font-medium">合并后删除原有映射</span>
              <span className="block text-muted-foreground">删除后不可恢复；目标映射本身不会被删除。</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setMergeOpen(false)}>取消</Button>
          <Button
            variant={mergeDeleteSources ? 'destructive' : 'default'}
            disabled={!selectedProtocol || !mergeSources.length || (mergeMode === 'new' ? !mergeName.trim() : !mergeTarget) || mergeMutation.isPending}
            onClick={() => {
              if (!selectedProtocol) return
              if (mergeDeleteSources && !window.confirm(`合并后将删除 ${mergeSources.length} 个原有映射，确定继续？`)) return
              mergeMutation.mutate({
                protocol: selectedProtocol,
                sources: mergeSources,
                target_alias_name: mergeMode === 'new' ? mergeName.trim() : mergeTarget,
                ...(mergeMode === 'new' ? { group_id: mergeGroup || null } : {}),
                delete_sources: mergeDeleteSources,
              })
            }}
          >
            {mergeMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />} 合并
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
