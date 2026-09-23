import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2, X } from 'lucide-react'
import type { AliasTarget, ModelAlias, Provider, ProviderModel, RoutingConfig } from '@/api/types'
import { SearchableSelect } from '@/components/searchable-select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type RoutingMode = RoutingConfig['mode']

export interface RoutingFormState {
  mode: RoutingMode
  max_attempts: string
  cooldown_seconds: string
  affinity_seconds: string
}

export const emptyRoutingForm: RoutingFormState = { mode: 'single', max_attempts: '', cooldown_seconds: '', affinity_seconds: '' }

export function parseRoutingForm(json: string | null): RoutingFormState {
  if (!json) return emptyRoutingForm
  try {
    const config = JSON.parse(json) as RoutingConfig
    if (config.mode !== 'weighted' && config.mode !== 'failover') return emptyRoutingForm
    return {
      mode: config.mode,
      max_attempts: config.max_attempts != null ? String(config.max_attempts) : '',
      cooldown_seconds: config.cooldown_seconds != null ? String(config.cooldown_seconds) : '',
      affinity_seconds: config.affinity_seconds != null ? String(config.affinity_seconds) : '',
    }
  } catch {
    return emptyRoutingForm
  }
}

export function buildRoutingConfig(form: RoutingFormState): { config: RoutingConfig | null; error?: string } {
  if (form.mode === 'single') return { config: { mode: 'single' } }
  const optionalInt = (raw: string, label: string, min: number, max: number): { value?: number; error?: string } => {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return { error: `${label} 需为 ${min}-${max} 的整数` }
    return { value: parsed }
  }
  const attempts = optionalInt(form.max_attempts, '最大尝试数', 1, 10)
  if (attempts.error) return { config: null, error: attempts.error }
  const cooldown = optionalInt(form.cooldown_seconds, '冷却时长', 0, 3600)
  if (cooldown.error) return { config: null, error: cooldown.error }
  const affinity = optionalInt(form.affinity_seconds, '亲和时长', 0, 3600)
  if (affinity.error) return { config: null, error: affinity.error }
  return {
    config: {
      mode: form.mode,
      ...(attempts.value !== undefined ? { max_attempts: attempts.value } : {}),
      ...(cooldown.value !== undefined ? { cooldown_seconds: cooldown.value } : {}),
      ...(affinity.value !== undefined ? { affinity_seconds: affinity.value } : {}),
    },
  }
}

export const routingModeLabels: Record<RoutingMode, string> = {
  single: 'single · 仅当前目标',
  weighted: 'weighted · 加权随机',
  failover: 'failover · 优先级故障转移',
}

export function TargetPanel({
  alias,
  providers,
  models,
  onAdd,
  onActivate,
  onDelete,
  onReorder,
  onWeight,
  onRoutingConfig,
}: {
  alias: ModelAlias
  providers: Provider[]
  models: ProviderModel[]
  onAdd: (provider_id: string, model_id: string) => void
  onActivate: (target: AliasTarget) => void
  onDelete: (target: AliasTarget) => void
  onReorder: (targets: AliasTarget[]) => void
  onWeight: (target: AliasTarget, weight: number) => void
  onRoutingConfig: (config: RoutingConfig) => void
}) {
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [routingForm, setRoutingForm] = useState<RoutingFormState>(() => parseRoutingForm(alias.routing_config_json))
  const [routingError, setRoutingError] = useState<string | null>(null)
  /** 权重输入本地草稿：允许清空，合法整数才提交 */
  const [weightDrafts, setWeightDrafts] = useState<Record<string, string>>({})
  const availableProviders = providers.filter((p) => p.protocol === alias.protocol && p.enabled === 1)
  // 未选 Provider 时搜索同协议全部已启用 Provider 的真实模型（选中后回填上方 Provider）；
  // 已选 Provider 时仅展示该 Provider 的模型
  const searchableModels = models.filter((m) => m.protocol === alias.protocol && m.provider_enabled === 1 && m.enabled === 1 && (!providerId || m.provider_id === providerId))
  const existing = new Set(alias.targets.map((t) => `${t.provider_id}/${t.model_id}`))

  useEffect(() => setRoutingForm(parseRoutingForm(alias.routing_config_json)), [alias.routing_config_json])

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
        <div className="text-xs font-semibold">
          {routingForm.mode === 'weighted' ? '候选目标（按权重随机分配）' : routingForm.mode === 'failover' ? '候选目标（按优先级故障转移）' : '候选目标（仅使用当前激活目标）'}
        </div>
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
              <label className="flex shrink-0 items-center gap-1 text-muted-foreground" title="分配权重（weighted 模式生效；0 = 仅末位备选）">
                权重
                <Input
                  type="number"
                  min={0}
                  max={10000}
                  value={weightDrafts[String(target.id)] ?? String(target.weight)}
                  className="h-7 w-16 text-xs"
                  onChange={(e) => {
                    const raw = e.target.value
                    setWeightDrafts((prev) => ({ ...prev, [String(target.id)]: raw }))
                    if (raw === '') return
                    const value = Number(raw)
                    if (Number.isInteger(value) && value >= 0 && value <= 10000) {
                      onWeight(target, value)
                    }
                  }}
                  onBlur={() => {
                    // 失焦时把非法/清空草稿回退为服务端值
                    const raw = weightDrafts[String(target.id)]
                    if (raw === undefined) return
                    const value = Number(raw)
                    if (raw === '' || !Number.isInteger(value) || value < 0 || value > 10000) {
                      setWeightDrafts((prev) => {
                        const next = { ...prev }
                        delete next[String(target.id)]
                        return next
                      })
                    }
                  }}
                />
              </label>
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
                  aria-label={`提高 ${target.model_id} 优先级`}
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
                  aria-label={`降低 ${target.model_id} 优先级`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => onDelete(target)} title="删除候选" aria-label={`删除候选 ${target.model_id}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )
        })}
        {!alias.targets.length && <p className="py-2 text-xs text-muted-foreground">暂无候选目标，映射当前不可调用。</p>}
      </div>
      <div className="space-y-2 border-t pt-3">
        <Label className="text-xs">路由模式</Label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Select value={routingForm.mode} onValueChange={(value) => setRoutingForm({ ...routingForm, mode: value as RoutingMode })}>
            <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(routingModeLabels) as RoutingMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>{routingModeLabels[mode]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {routingForm.mode !== 'single' && (
            <>
              <Input
                type="number" min={1} max={10}
                className="h-8 w-full text-xs sm:w-28"
                value={routingForm.max_attempts}
                onChange={(e) => setRoutingForm({ ...routingForm, max_attempts: e.target.value })}
                placeholder="尝试数(默认全部)"
                title="同一候选连续失败多少次后冷却；也限制单次请求最多尝试的候选数"
              />
              <Input
                type="number" min={0} max={3600}
                className="h-8 w-full text-xs sm:w-28"
                value={routingForm.cooldown_seconds}
                onChange={(e) => setRoutingForm({ ...routingForm, cooldown_seconds: e.target.value })}
                placeholder="冷却秒(默认60)"
                title="候选进入冷却后的持续时间"
              />
              <Input
                type="number" min={0} max={3600}
                className="h-8 w-full text-xs sm:w-28"
                value={routingForm.affinity_seconds}
                onChange={(e) => setRoutingForm({ ...routingForm, affinity_seconds: e.target.value })}
                placeholder="亲和秒(默认0)"
                title="探测/故障切换成功后，一段时间内固定使用该候选"
              />
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            className="w-full shrink-0 sm:w-auto"
            onClick={async () => {
              const built = buildRoutingConfig(routingForm)
              if (built.error || !built.config) { setRoutingError(built.error ?? '路由配置无效'); return }
              setRoutingError(null)
              onRoutingConfig(built.config)
            }}
          >保存路由</Button>
        </div>
        {routingForm.mode !== 'single' && <p className="text-xs text-muted-foreground">候选连续失败达阈值后冷却并跳过；全部冷却时仅放行一个探测请求；探测/切换成功后亲和期内固定使用该候选。</p>}
        {routingError && <p className="text-xs text-destructive">{routingError}</p>}
      </div>
      <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="text-xs">Provider</Label>
          <div className="flex items-center gap-1">
            <Select value={providerId} onValueChange={(value) => { setProviderId(value); setModelId('') }}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="选择 Provider" /></SelectTrigger>
              <SelectContent>{availableProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent>
            </Select>
            {providerId && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                title="清空"
                aria-label="清空 Provider"
                onClick={() => { setProviderId(''); setModelId('') }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
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
            placeholder="模型名"
            searchPlaceholder="模型名"
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
