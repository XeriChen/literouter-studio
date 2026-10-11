import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  ArrowUpRight,
  Box,
  Braces,
  Check,
  CircleDot,
  Copy,
  Cpu,
  LayoutDashboard,
  MessageSquare,
  Radio,
  Route,
  Server,
  Sparkles,
  Terminal,
  X,
  Zap,
} from 'lucide-react'
import { api } from '@/api/client'
import { copyText } from '@/lib/clipboard'
import type { ModelAlias, Provider, ProviderModel } from '@/api/types'
import { isAliasAvailable } from '@/lib/aliases'

const ENDPOINTS = ['/openai/v1/chat/completions', '/anthropic/v1/messages']

export default function Home() {
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('/api/providers') })
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ProviderModel[]>('/api/models') })
  const aliases = useQuery({ queryKey: ['aliases'], queryFn: () => api<ModelAlias[]>('/api/aliases') })
  const availableAliases = (aliases.data ?? []).filter(isAliasAvailable)
  const providerRows = providers.data ?? []
  const modelRows = models.data ?? []
  const enabledProviders = providerRows.filter((provider) => provider.enabled).length
  const enabledModels = modelRows.filter((model) => model.enabled).length
  const setupReady = !aliases.isError && availableAliases.length > 0

  const [copied, setCopied] = useState<{ path: string; ok: boolean } | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activeSnippetTab, setActiveSnippetTab] = useState<'openai' | 'anthropic'>('openai')
  const [curlCopied, setCurlCopied] = useState(false)

  const copyEndpoint = (path: string) => {
    void copyText(`${window.location.origin}${path}`).then((ok) => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      setCopied({ path, ok })
      copiedTimer.current = setTimeout(() => setCopied(null), 2000)
    })
  }

  const snippetAlias = availableAliases.find((alias) => alias.protocol === activeSnippetTab)
  const snippetBody = JSON.stringify({
    model: snippetAlias?.alias_name ?? '<MODEL_ALIAS>',
    ...(activeSnippetTab === 'anthropic' ? { max_tokens: 1024 } : {}),
    messages: [{ role: 'user', content: 'Hello LiteRouter' }],
  }, null, 2)
  // JSON 放入 shell 单引号时，映射名中的单引号也必须保留为字面量。
  const shellBody = snippetBody.replaceAll("'", "'\\''")
  const curl = [
    `curl -X POST ${window.location.origin}${ENDPOINTS[activeSnippetTab === 'openai' ? 0 : 1]}`,
    activeSnippetTab === 'openai'
      ? '  -H "Authorization: Bearer <GATEWAY_TOKEN>"'
      : '  -H "x-api-key: <GATEWAY_TOKEN>"',
    ...(activeSnippetTab === 'anthropic' ? ['  -H "anthropic-version: 2023-06-01"'] : []),
    '  -H "Content-Type: application/json"',
    `  -d '${shellBody}'`,
  ].join(' \\\n')

  const copyCurl = () => {
    void copyText(curl).then((ok) => {
      if (ok) {
        setCurlCopied(true)
        setTimeout(() => setCurlCopied(false), 2000)
      }
    })
  }

  const setupSteps: Array<{ number: string; title: string; description: string; to: string; icon: LucideIcon }> = [
    { number: '01', title: '连接', description: '添加上游 Provider 节点', to: '/providers', icon: LayoutDashboard },
    { number: '02', title: '整理', description: '导入并启用映射与模型', to: '/models', icon: Box },
    { number: '03', title: '验证', description: '发起一次真实流式对话', to: '/playground', icon: MessageSquare },
  ]

  return (
    <div className="page-shell space-y-8">
      {/* 顶部 Hero 区域与背景发光氛效 */}
      <section className="relative overflow-hidden rounded-2xl border border-foreground/10 bg-gradient-to-b from-card/90 to-card/50 p-6 sm:p-10 shadow-sm backdrop-blur-xl">
        {/* 背景氛围发光光晕 */}
        <div className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-primary/10 blur-[100px]" />
        <div className="pointer-events-none absolute -right-20 -bottom-20 h-72 w-72 rounded-full bg-accent/15 blur-[120px]" />

        <div className="pointer-events-none absolute -right-4 -top-12 select-none font-mono text-[140px] font-black leading-none tracking-[-0.15em] text-foreground/[.025] sm:text-[220px]">
          LR
        </div>

        <div className="relative max-w-4xl">
          <div className="eyebrow mb-4 flex items-center gap-2">
            <span className="pulse-radar h-2 w-2 rounded-full bg-[hsl(var(--success))]" />
            <span className="font-semibold text-foreground/80">控制台 / 系统总览</span>
          </div>

          <h1 className="text-3xl font-black leading-[1.05] tracking-[-0.05em] sm:text-5xl text-foreground">
            每一次请求，<br />
            <span className="bg-gradient-to-r from-primary via-emerald-400 to-teal-400 bg-clip-text text-transparent">
              都值得被看见。
            </span>
          </h1>

          <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            原生透传的 LLM 聚合网关。连接上游、整理映射、故障转移，在一个安静而有力的工作台里观察每一次路由。
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/playground"
              className="group inline-flex h-10 items-center gap-2.5 rounded-lg bg-primary px-5 text-xs font-bold text-primary-foreground shadow-md shadow-primary/20 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/30"
            >
              <Zap className="h-3.5 w-3.5 fill-current" />
              打开 Playground
              <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
            <Link
              to="/providers"
              className="inline-flex h-10 items-center gap-2.5 rounded-lg border border-foreground/15 bg-card/60 px-5 text-xs font-bold transition-all duration-150 hover:-translate-y-0.5 hover:bg-muted hover:border-foreground/30"
            >
              管理连接
              <LayoutDashboard className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>
            <Link
              to="/models"
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-transparent px-4 text-xs font-semibold text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              <Box className="h-3.5 w-3.5" />
              配置模型映射
            </Link>
          </div>
        </div>
      </section>

      {/* 核心指标卡片矩阵 */}
      <section className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="连接节点"
          value={providers.isLoading ? '—' : providerRows.length}
          detail={`${enabledProviders} 个节点正常启用`}
          icon={Radio}
          badge="Upstream"
          accent="emerald"
        />
        <Metric
          label="可用模型"
          value={models.isLoading ? '—' : enabledModels}
          detail={`${modelRows.length} 个模型已发现`}
          icon={Box}
          badge="Discovered"
          accent="cyan"
        />
        <Metric
          label="路由状态"
          value={setupReady ? 'LIVE' : 'SETUP'}
          detail={setupReady ? '原生协议实时透传' : '等待完成链路配置'}
          icon={Route}
          badge={setupReady ? 'ACTIVE' : 'READY'}
          accent="emerald"
          live={setupReady}
        />
        <Metric
          label="协议支持"
          value="02"
          detail="OpenAI / Anthropic 双原生"
          icon={Braces}
          badge="Dual Engine"
          accent="indigo"
        />
      </section>

      {/* 动态可视化流向架构图卡片 */}
      <section className="rounded-2xl border border-foreground/10 bg-card/75 p-6 backdrop-blur-xl shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-foreground/10 pb-5">
          <div>
            <div className="eyebrow flex items-center gap-1.5 text-primary">
              <Sparkles className="h-3 w-3" />
              Pipeline Architecture
            </div>
            <h2 className="mt-1 text-lg font-bold tracking-tight">原生数据流管道与路由拓扑</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">原生透传 · 仅改写模型与配置的思考字段</span>
          </div>
        </div>

        {/* 交互式链路流程图 */}
        <div className="mt-6 grid grid-cols-1 items-center gap-4 lg:grid-cols-5">
          {/* 节点 1: Client */}
          <div className="glass-card flex flex-col items-center p-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
              <Terminal className="h-5 w-5" />
            </div>
            <div className="mt-3 text-sm font-bold">客户端应用</div>
            <div className="font-mono text-[10px] text-muted-foreground mt-0.5">Cursor / Claude / Next.js</div>
            <div className="mt-3 inline-flex items-center gap-1 rounded bg-muted/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              <span>POST /openai or /anthropic</span>
            </div>
          </div>

          {/* 连线 1 */}
          <div className="relative hidden lg:flex flex-col items-center justify-center">
            <div className="h-0.5 w-full bg-gradient-to-r from-foreground/20 via-primary to-foreground/20 relative overflow-hidden">
              <div className="absolute inset-0 bg-primary/80 animate-pulse" />
            </div>
            <span className="font-mono text-[9px] text-primary mt-1">原生请求体</span>
          </div>

          {/* 节点 2: LiteRouter Core */}
          <div className="glass-card border-primary/30 bg-primary/5 p-4 text-center shadow-lg shadow-primary/5 relative overflow-hidden">
            <div className="signal-line absolute inset-0 opacity-40 pointer-events-none" />
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/30">
              <Cpu className="h-5 w-5" />
            </div>
            <div className="mt-3 text-sm font-extrabold text-foreground">LiteRouter 网关</div>
            <div className="font-mono text-[10px] text-primary font-semibold mt-0.5">定点改写 model + 思考配置</div>
            <div className="mt-3 flex items-center justify-center gap-1 font-mono text-[9px]">
              <span className="rounded bg-background/80 px-1.5 py-0.5 border border-foreground/10">加权随机</span>
              <span className="rounded bg-background/80 px-1.5 py-0.5 border border-foreground/10">故障转移</span>
            </div>
          </div>

          {/* 连线 2 */}
          <div className="relative hidden lg:flex flex-col items-center justify-center">
            <div className="h-0.5 w-full bg-gradient-to-r from-foreground/20 via-emerald-400 to-foreground/20 relative overflow-hidden">
              <div className="absolute inset-0 bg-emerald-400/80 animate-pulse" />
            </div>
            <span className="font-mono text-[9px] text-emerald-400 mt-1">零多余修改</span>
          </div>

          {/* 节点 3: Upstream Providers */}
          <div className="glass-card flex flex-col items-center p-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
              <Server className="h-5 w-5" />
            </div>
            <div className="mt-3 text-sm font-bold">上游服务商</div>
            <div className="font-mono text-[10px] text-muted-foreground mt-0.5">DeepSeek / OpenAI / Anthropic</div>
            <div className="mt-3 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-500 font-semibold">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span>流式直通 SSE</span>
            </div>
          </div>
        </div>
      </section>

      {/* 系统导航与代码快速调用卡片 */}
      <section className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        {/* 左侧：工作流指引地图 */}
        <div className="console-surface flex min-w-0 flex-col">
          <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
            <div>
              <div className="eyebrow">Quick Setup Guide</div>
              <h2 className="mt-0.5 text-base font-bold tracking-tight">把网关配置成你的专属工作流</h2>
            </div>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </div>

          <div className="grid flex-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-foreground/10">
            {setupSteps.map(({ number, title, description, to, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="group flex flex-col justify-between p-5 transition-all duration-200 hover:bg-muted/50"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-muted-foreground/60">{number}</span>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
                  </div>
                  <div className="mt-8 flex h-10 w-10 items-center justify-center rounded-lg bg-muted/60 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="mt-4 text-sm font-extrabold">{title}</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</div>
                </div>
                <div className="mt-6 flex items-center gap-1 text-[11px] font-bold text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  立即前往 <ArrowUpRight className="h-3 w-3" />
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* 右侧：代码接入与快速测试 Terminal */}
        <div className="console-surface flex min-w-0 flex-col">
          <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <span className="flex gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
              </span>
              <span className="ml-2 font-mono text-xs font-bold text-foreground">API 接入测试</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex rounded-md bg-muted/60 p-0.5 text-[11px] font-medium">
                <button
                  type="button"
                  onClick={() => setActiveSnippetTab('openai')}
                  className={`rounded px-2.5 py-1 transition-colors ${
                    activeSnippetTab === 'openai'
                      ? 'bg-card text-foreground shadow-sm font-bold'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  OpenAI
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSnippetTab('anthropic')}
                  className={`rounded px-2.5 py-1 transition-colors ${
                    activeSnippetTab === 'anthropic'
                      ? 'bg-card text-foreground shadow-sm font-bold'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Anthropic
                </button>
              </div>

              <button
                type="button"
                onClick={copyCurl}
                className="icon-button h-7 w-7 text-muted-foreground hover:text-foreground"
                title="复制 cURL 命令"
              >
                {curlCopied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="min-w-0 flex-1 p-4 font-mono text-[11px] leading-relaxed">
            <div className="text-muted-foreground"># 直接调用本地网关</div>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-emerald-300">
              <code>{curl}</code>
            </pre>

            <p className="mt-2 text-xs text-muted-foreground">model 使用当前协议的可用映射名；未配置时请替换 &lt;MODEL_ALIAS&gt;。</p>

            <div className="mt-4 space-y-2 border-t border-foreground/10 pt-3">
              <div className="eyebrow text-muted-foreground">Endpoints</div>
              {ENDPOINTS.map((path) => {
                const isCopied = copied?.path === path
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => copyEndpoint(path)}
                    className="group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      {isCopied ? (
                        copied.ok ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : (
                          <X className="h-3 w-3 text-destructive" />
                        )
                      ) : (
                        <CircleDot className="h-3 w-3 text-primary" />
                      )}
                      <span className="font-mono text-[11px] text-foreground">{path}</span>
                    </span>
                    <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 flex items-center gap-1">
                      {isCopied ? (copied.ok ? '已复制' : '复制失败') : '点击复制'}
                      <Copy className="h-2.5 w-2.5" />
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      {/* 异常或未就绪状态通知 */}
      {(providers.isError || models.isError || aliases.isError) && (
        <div className="notice notice-error border border-white/[0.14] px-4 py-3">
          <Activity className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            加载概览数据失败：
            {providers.error instanceof Error
              ? providers.error.message
              : models.error instanceof Error
                ? models.error.message
                : aliases.error instanceof Error
                  ? aliases.error.message
                  : 'unknown'}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 font-semibold underline underline-offset-4"
            onClick={() => {
              providers.refetch()
              models.refetch()
              aliases.refetch()
            }}
          >
            重试
          </button>
        </div>
      )}

      {!setupReady && !providers.isLoading && !models.isLoading && !aliases.isLoading && (
        <div className="notice notice-warning border border-white/[0.14] px-4 py-3">
          <Activity className="mt-0.5 h-4 w-4 shrink-0" />
          <span>还没有完整的路由链路。先添加 Provider、导入模型并启用映射及其目标，即可在 Playground 发起请求。</span>
          <Link to="/providers" className="ml-auto shrink-0 font-semibold underline underline-offset-4">
            开始配置
          </Link>
        </div>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  badge,
  accent,
  live,
}: {
  label: string
  value: string | number
  detail: string
  icon: LucideIcon
  badge: string
  accent: 'emerald' | 'cyan' | 'indigo'
  live?: boolean
}) {
  const accentColors = {
    emerald: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
    cyan: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/20',
    indigo: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
  }

  return (
    <div className="glass-card glass-card-hover group relative overflow-hidden p-5">
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <div className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-mono font-bold ${accentColors[accent]}`}>
          {live && <span className="pulse-radar h-1.5 w-1.5 rounded-full bg-emerald-500" />}
          <span>{badge}</span>
        </div>
      </div>

      <div className="mt-5 flex items-baseline justify-between">
        <div className="text-3xl font-black tracking-[-0.05em] text-foreground sm:text-4xl">{value}</div>
        <div className="rounded-lg bg-muted/60 p-2 text-muted-foreground transition-all duration-200 group-hover:bg-primary group-hover:text-primary-foreground">
          <Icon className="h-4 w-4" />
        </div>
      </div>

      <div className="mt-2.5 font-mono text-[11px] text-muted-foreground">{detail}</div>
    </div>
  )
}
