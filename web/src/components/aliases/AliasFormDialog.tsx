import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Check, TextCursorInput, X } from 'lucide-react'
import { api } from '@/api/client'
import type { AliasGroup, ModelAlias, Provider, ProviderModel, ThinkingConfig } from '@/api/types'
import { SearchableSelect } from '@/components/searchable-select'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type Protocol = 'openai' | 'anthropic'

export const openaiEffortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export interface ThinkingFormState {
  mode: 'off' | 'override' | 'default'
  anthropicType: 'enabled' | 'disabled'
  budget: string
  effort: string
}

export const emptyThinkingForm: ThinkingFormState = { mode: 'off', anthropicType: 'enabled', budget: '4096', effort: 'medium' }

export function parseThinkingForm(thinkingJson: string | null): ThinkingFormState {
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

export function buildThinking(form: ThinkingFormState, protocol: Protocol): { config: ThinkingConfig | null; error?: string } {
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

export function thinkingBadge(thinkingJson: string | null): string | null {
  try {
    if (!thinkingJson) return null
    const config = JSON.parse(thinkingJson) as ThinkingConfig
    return config.mode === 'override' ? '思考·覆盖' : config.mode === 'default' ? '思考·默认' : null
  } catch {
    return null
  }
}

export function parseThinkingConfig(thinkingJson: string | null): ThinkingConfig | null {
  if (!thinkingJson) return null
  try {
    const config = JSON.parse(thinkingJson) as ThinkingConfig
    return config.mode === 'override' || config.mode === 'default' ? config : null
  } catch {
    return null
  }
}

export function ThinkingFields({ protocol, form, onChange }: { protocol: Protocol; form: ThinkingFormState; onChange: (form: ThinkingFormState) => void }) {
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

export function AliasCreateDialog({
  open,
  onOpenChange,
  groups,
  providers,
  models,
  onCreated,
  toast,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: AliasGroup[]
  providers: Provider[]
  models: ProviderModel[]
  onCreated: () => void
  toast: (ok: boolean, message: string) => void
}) {
  const [addForm, setAddForm] = useState<{ protocol: Protocol; alias_name: string; group_id: string; provider_id: string; model_id: string }>({ protocol: 'openai', alias_name: '', group_id: '', provider_id: '', model_id: '' })
  const [addThinking, setAddThinking] = useState<ThinkingFormState>(emptyThinkingForm)

  const addProviders = providers.filter((provider) => provider.protocol === addForm.protocol && provider.enabled === 1)
  // 未选 Provider 时搜索同协议全部已启用 Provider 的真实模型（选中后回填 Provider）；已选 Provider 时仅展示该 Provider 的模型
  const addModels = models.filter((model) => model.protocol === addForm.protocol && model.provider_enabled === 1 && model.enabled === 1 && (!addForm.provider_id || model.provider_id === addForm.provider_id))
  const addGroups = groups.filter((group) => group.protocol === addForm.protocol)

  const addAliasMutation = useMutation({
    mutationFn: () => {
      const built = buildThinking(addThinking, addForm.protocol)
      if (built.error) return Promise.reject(new Error(built.error))
      return api('/api/aliases', { method: 'POST', body: JSON.stringify({ ...addForm, group_id: addForm.group_id || null, alias_name: addForm.alias_name.trim(), thinking: built.config ?? undefined }) })
    },
    onSuccess: () => {
      onOpenChange(false)
      setAddForm({ protocol: 'openai', alias_name: '', group_id: '', provider_id: '', model_id: '' })
      setAddThinking(emptyThinkingForm)
      onCreated()
      toast(true, '映射创建成功')
    },
    onError: (error) => toast(false, error instanceof Error ? error.message : '创建失败'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>新建模型映射</DialogTitle>
          <DialogDescription>选中模型后自动填充映射名。</DialogDescription>
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
                <button type="button" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAddForm((form) => ({ ...form, alias_name: form.model_id }))}>
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
            <div className="flex items-center gap-1">
              <Select value={addForm.provider_id} onValueChange={(value) => setAddForm({ ...addForm, provider_id: value, model_id: '' })}>
                <SelectTrigger><SelectValue placeholder="全部" /></SelectTrigger>
                <SelectContent>
                  {addProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {addForm.provider_id && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                  title="清空"
                  aria-label="清空 Provider"
                  onClick={() => setAddForm((form) => ({ ...form, provider_id: '', model_id: '' }))}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>当前目标</Label>
            <SearchableSelect
              value={addForm.provider_id && addForm.model_id ? `${addForm.provider_id}/${addForm.model_id}` : ''}
              onValueChange={(_value, option) => {
                if (!option.meta) return
                const model = option.meta
                setAddForm((form) => ({
                  ...form,
                  provider_id: model.provider_id,
                  model_id: model.model_id,
                  alias_name: form.alias_name.trim() ? form.alias_name : model.model_id,
                }))
              }}
              ariaLabel="当前目标"
              placeholder="模型名"
              searchPlaceholder="模型名"
              emptyText="无匹配结果"
              options={addModels.map((model) => ({
                value: `${model.provider_id}/${model.model_id}`,
                label: model.display_name || model.model_id,
                keywords: [model.model_id, ...(model.display_name ? [model.display_name] : []), model.provider_name],
                group: model.provider_name,
                meta: model,
              }))}
            />
          </div>
          <ThinkingFields protocol={addForm.protocol} form={addThinking} onChange={setAddThinking} />
        </div>
        <DialogFooter className="shrink-0 border-t pt-2 sm:border-t-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={addAliasMutation.isPending || !addForm.alias_name.trim() || !addForm.provider_id || !addForm.model_id} onClick={() => addAliasMutation.mutate()}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AliasEditDialog({
  editing,
  onEditingChange,
  groups,
  form,
  onFormChange,
  onSave,
  pending,
}: {
  editing: ModelAlias | null
  onEditingChange: (alias: ModelAlias | null) => void
  groups: AliasGroup[]
  form: { alias_name: string; group_id: string }
  onFormChange: (form: { alias_name: string; group_id: string }) => void
  onSave: () => void
  pending: boolean
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onEditingChange(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑映射</DialogTitle>
          <DialogDescription>只修改映射名与所属分组；启用开关、思考等级和候选目标请在列表中单独操作。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>映射名</Label>
            <Input autoFocus value={form.alias_name} onChange={(event) => onFormChange({ ...form, alias_name: event.target.value })} placeholder="my-brain" />
          </div>
          <div className="space-y-1.5">
            <Label>分组</Label>
            <Select value={form.group_id || 'none'} onValueChange={(value) => onFormChange({ ...form, group_id: value === 'none' ? '' : value })}>
              <SelectTrigger><SelectValue placeholder="未分组" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未分组</SelectItem>
                {groups.filter((group) => group.protocol === editing?.protocol).map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onEditingChange(null)}>取消</Button>
          <Button disabled={!form.alias_name.trim() || pending} onClick={onSave}><Check className="h-4 w-4" /> 保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AliasThinkingDialog({
  alias,
  onAliasChange,
  form,
  onFormChange,
  onSave,
  pending,
}: {
  alias: ModelAlias | null
  onAliasChange: (alias: ModelAlias | null) => void
  form: ThinkingFormState
  onFormChange: (form: ThinkingFormState) => void
  onSave: () => void
  pending: boolean
}) {
  return (
    <Dialog open={alias !== null} onOpenChange={(open) => !open && onAliasChange(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>思考等级 — {alias?.alias_name}</DialogTitle>
          <DialogDescription>仅改写请求体顶层的 {alias?.protocol === 'openai' ? 'reasoning_effort' : 'thinking'} 字段，其余字段原样透传。</DialogDescription>
        </DialogHeader>
        {alias && <ThinkingFields protocol={alias.protocol} form={form} onChange={onFormChange} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onAliasChange(null)}>取消</Button>
          <Button disabled={pending} onClick={onSave}><Check className="h-4 w-4" /> 保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
