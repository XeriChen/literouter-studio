import { Eye, EyeOff, FolderPlus, Loader2, Unlock } from 'lucide-react'
import type { Provider, ProviderGroup } from '@/api/types'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export type Protocol = Provider['protocol']
export type FormMode = 'create' | 'edit' | 'copy'

export interface ProviderForm {
  name: string
  protocol: Protocol
  group_id: string
  base_url: string
  api_key: string
  access_token: string
  anthropic_version: string
  proxy_url: string
  timeout_ms: string
  custom_headers: string
  model_filter: string
  upstream_type: string
  custom_auth_header_name: string
  custom_auth_format: string
}

export const EMPTY_FORM: ProviderForm = {
  name: '',
  protocol: 'openai',
  group_id: '',
  base_url: '',
  api_key: '',
  access_token: '',
  anthropic_version: '',
  proxy_url: '',
  timeout_ms: '',
  custom_headers: '{}',
  model_filter: '',
  upstream_type: '',
  custom_auth_header_name: '',
  custom_auth_format: '',
}

export function formFromProvider(provider: Provider, name = provider.name): ProviderForm {
  const customAuth = typeof provider.auth.custom_auth === 'object' && provider.auth.custom_auth !== null
    ? provider.auth.custom_auth as { header_name: string; format: string }
    : null
  return {
    name,
    protocol: provider.protocol,
    group_id: provider.group_id ?? '',
    base_url: provider.base_url,
    api_key: (provider.auth.api_key as string | undefined) ?? '',
    access_token: (provider.auth.access_token as string | undefined) ?? '',
    anthropic_version: (provider.auth.version as string | undefined) ?? '',
    proxy_url: provider.proxy_url ?? '',
    timeout_ms: provider.timeout_ms == null ? '' : String(provider.timeout_ms),
    custom_headers: JSON.stringify(provider.custom_headers ?? {}, null, 2),
    model_filter: provider.model_filter ?? '',
    upstream_type: provider.upstream_type ?? '',
    custom_auth_header_name: customAuth?.header_name ?? '',
    custom_auth_format: customAuth?.format ?? '',
  }
}

export function ProviderFormDialog({
  open,
  onOpenChange,
  formMode,
  form,
  onFormChange,
  apiKeyVisible,
  onApiKeyVisibleChange,
  resultNotice,
  providerGroups,
  onOpenGroupDialog,
  decodeApiKey,
  savePending,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  formMode: FormMode
  form: ProviderForm
  onFormChange: (form: ProviderForm) => void
  apiKeyVisible: boolean
  onApiKeyVisibleChange: (visible: boolean) => void
  resultNotice: ReactNode
  providerGroups: ProviderGroup[]
  onOpenGroupDialog: (protocol: Protocol, source: 'page' | 'provider') => void
  decodeApiKey: () => void
  savePending: boolean
  onSave: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) onApiKeyVisibleChange(false) }}>
      <DialogContent className="grid max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-md p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-full">
        <DialogHeader className="border-b px-4 py-4 pr-12 text-left sm:px-6 sm:py-5">
          <DialogTitle>{formMode === 'edit' ? '编辑 Provider' : formMode === 'copy' ? '复制 Provider' : '新增 Provider'}</DialogTitle>
          <DialogDescription>API Key 会以明文存储在本机数据库中，请妥善保管。</DialogDescription>
          {resultNotice}
        </DialogHeader>
        <div
          className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
          role="region"
          aria-label="Provider 配置"
          tabIndex={0}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="provider-name">名称</Label><Input id="provider-name" value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} placeholder="如：OpenAI 官方" /></div><div className="space-y-1.5"><Label>协议</Label><Select disabled={formMode === 'edit'} value={form.protocol} onValueChange={(value) => onFormChange({ ...form, protocol: value as Protocol, group_id: value === form.protocol ? form.group_id : '' })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">openai</SelectItem><SelectItem value="anthropic">anthropic</SelectItem></SelectContent></Select></div></div>
          <div className="space-y-1.5"><Label>分组（可选）</Label><div className="flex gap-2"><Select value={form.group_id || 'none'} onValueChange={(value) => onFormChange({ ...form, group_id: value === 'none' ? '' : value })}><SelectTrigger className="flex-1"><SelectValue placeholder="未分组" /></SelectTrigger><SelectContent><SelectItem value="none">未分组</SelectItem>{providerGroups.filter((group) => group.protocol === form.protocol).map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" size="icon" onClick={() => onOpenGroupDialog(form.protocol, 'provider')} aria-label="新建 Provider 分组" title="新建 Provider 分组"><FolderPlus className="h-4 w-4" /></Button></div></div>
          <div className="space-y-1.5"><Label htmlFor="provider-base-url">Base URL</Label><Input id="provider-base-url" value={form.base_url} onChange={(event) => onFormChange({ ...form, base_url: event.target.value })} placeholder="https://api.openai.com" /><p className="text-xs text-muted-foreground">不含 /v1 后缀，网关会自动拼接</p></div>
          <div className="space-y-1.5"><Label htmlFor="provider-api-key">API Key</Label><div className="flex gap-2"><div className="relative min-w-0 flex-1"><Input className="pr-10" type={apiKeyVisible ? 'text' : 'password'} value={form.api_key} onChange={(event) => onFormChange({ ...form, api_key: event.target.value })} placeholder="sk-..." id="provider-api-key" /><Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2" onClick={() => onApiKeyVisibleChange(!apiKeyVisible)} aria-label={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'} title={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'}>{apiKeyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</Button></div><Button type="button" variant="outline" className="shrink-0" onClick={decodeApiKey} title="Base64 解码并回填为明文"><Unlock className="h-3.5 w-3.5" /> 解码</Button></div><p className="text-xs text-muted-foreground">如粘贴的是 Base64 编码的 Key，点击「解码」直接转成明文</p></div>
          {form.protocol === 'anthropic' && <div className="space-y-1.5"><Label>Anthropic Version（可选）</Label><Input value={form.anthropic_version} onChange={(event) => onFormChange({ ...form, anthropic_version: event.target.value })} placeholder="2023-06-01（留空使用默认值）" /></div>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label>代理 URL（可选）</Label><Input value={form.proxy_url} onChange={(event) => onFormChange({ ...form, proxy_url: event.target.value })} placeholder="http://127.0.0.1:7890" /></div><div className="space-y-1.5"><Label>超时毫秒</Label><Input value={form.timeout_ms} onChange={(event) => onFormChange({ ...form, timeout_ms: event.target.value })} placeholder="120000（0 表示不超时）" /></div></div>
          <div className="space-y-1.5"><Label>上游类型（可选）</Label><Select value={form.upstream_type || 'none'} onValueChange={(value) => onFormChange({ ...form, upstream_type: value === 'none' ? '' : value })}><SelectTrigger><SelectValue placeholder="未指定" /></SelectTrigger><SelectContent><SelectItem value="none">未指定</SelectItem><SelectItem value="newapi">New API</SelectItem><SelectItem value="sub2api">Sub2API</SelectItem></SelectContent></Select><p className="text-xs text-muted-foreground">标记为 New API 或 Sub2API 可查询账户额度；可填 Access Token 查询用户总余额</p></div>
          {(form.upstream_type === 'newapi' || form.upstream_type === 'sub2api') && <div className="space-y-1.5"><Label>Access Token（可选，用户总余额）</Label><Input value={form.access_token} onChange={(event) => onFormChange({ ...form, access_token: event.target.value })} placeholder="eyJ... / PAT" /><p className="text-xs text-muted-foreground">{form.upstream_type === 'newapi' ? <>控制台登录态 / PAT，用于 <span className="font-mono">GET /api/user/self</span> 查询<strong>用户总余额</strong>（quota/500000=USD）；令牌额度仍可用 API Key 查 billing。该字段不参与代理转发</> : <>余额默认走 <span className="font-mono">/v1/usage</span>（API Key）。填 Sub2API 控制台 JWT 可查询<strong>用户总余额</strong>（<span className="font-mono">/api/v1/auth/me</span>）；该路由仅放行 JWT 时也依赖此字段。不参与代理转发</>}</p></div>}
          <div className="space-y-1.5"><Label>自定义请求头</Label><Textarea value={form.custom_headers} onChange={(event) => onFormChange({ ...form, custom_headers: event.target.value })} rows={3} className="font-mono text-xs" placeholder='{"X-Custom": "value"}' /><p className="text-xs text-muted-foreground">JSON 格式，不可覆盖 authorization / x-api-key / accept-encoding</p></div>
          <div className="space-y-1.5"><Label>自定义认证头（可选）</Label><div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><Input value={form.custom_auth_header_name} onChange={(event) => onFormChange({ ...form, custom_auth_header_name: event.target.value })} placeholder="X-API-Key" /><Input value={form.custom_auth_format} onChange={(event) => onFormChange({ ...form, custom_auth_format: event.target.value })} placeholder="Bearer {key}" /></div><p className="text-xs text-muted-foreground">自定义认证头名称和格式，{'{key}'} 会被替换为 API Key。留空使用默认认证方式</p></div>
          <div className="space-y-1.5"><Label>模型过滤规则（可选）</Label><Input value={form.model_filter} onChange={(event) => onFormChange({ ...form, model_filter: event.target.value })} placeholder="grok-*,mimo-*" /><p className="text-xs text-muted-foreground">逗号分隔的前缀匹配规则，拉取时只入库匹配的模型。留空不过滤。例：gpt-*,claude-*</p></div>
        </div>
        <DialogFooter className="gap-2 border-t bg-background px-4 py-3 sm:space-x-0 sm:px-6"><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={onSave} disabled={savePending || !form.name.trim() || !form.base_url.trim()}>{savePending && <Loader2 className="h-4 w-4 animate-spin" />}{formMode === 'edit' ? '保存修改' : formMode === 'copy' ? '创建副本' : '创建'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
