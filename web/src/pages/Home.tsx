import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { LayoutDashboard, Box, MessageSquare, ArrowRight } from 'lucide-react'
import { api } from '@/api/client'
import type { Provider, ProviderModel } from '@/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export default function Home() {
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<Provider[]>('/api/providers'),
  })
  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<ProviderModel[]>('/api/models'),
  })

  const providerCount = providers.data?.length ?? 0
  const enabledModelCount = (models.data ?? []).filter((m) => m.enabled).length

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          轻量级 LLM Provider 聚合网关，原生透传 OpenAI / Anthropic 协议，统一入口管理多个上游服务。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Providers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{providerCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">已启用模型</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{enabledModelCount}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">快速开始</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">1</div>
            <div>
              <p className="font-medium">添加 Provider</p>
              <p className="text-muted-foreground">在 <Link to="/providers" className="text-foreground underline underline-offset-4 hover:text-primary">Providers</Link> 页面配置上游服务地址和 API Key。</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">2</div>
            <div>
              <p className="font-medium">拉取并启用模型</p>
              <p className="text-muted-foreground">点击「拉取模型」从上游获取模型列表，勾选需要的模型导入，然后在 <Link to="/models" className="text-foreground underline underline-offset-4 hover:text-primary">Models</Link> 页面启用。</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">3</div>
            <div>
              <p className="font-medium">通过网关调用</p>
              <p className="text-muted-foreground">使用网关地址替代上游地址，请求格式完全兼容。OpenAI 走 <code className="rounded bg-muted px-1 py-0.5 text-xs">/openai/v1/chat/completions</code> 与 <code className="rounded bg-muted px-1 py-0.5 text-xs">/openai/v1/responses</code>，Anthropic 走 <code className="rounded bg-muted px-1 py-0.5 text-xs">/anthropic/v1/messages</code>。</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">使用方式</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Providers</span>
              <Badge variant="secondary" className="text-[10px]">管理</Badge>
            </div>
            <p className="pl-6 text-muted-foreground">接入 OpenAI / Anthropic 兼容的上游服务，支持自定义请求头、代理和超时配置。</p>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Box className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Models</span>
              <Badge variant="secondary" className="text-[10px]">管理</Badge>
            </div>
            <p className="pl-6 text-muted-foreground">管理可用模型，支持手动添加或从上游拉取。模型映射按协议隔离，客户端仅能通过映射名调用模型。</p>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Playground</span>
              <Badge variant="secondary" className="text-[10px]">测试</Badge>
            </div>
            <p className="pl-6 text-muted-foreground">选择已启用的模型直接对话测试，支持 OpenAI 和 Anthropic 流式响应。</p>
          </div>
        </CardContent>
      </Card>

      <div className="text-center">
        <Link
          to="/providers"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          前往管理 Providers <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  )
}
