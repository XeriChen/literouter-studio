import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import type { LucideIcon } from 'lucide-react'
import { Activity, ArrowUpRight, Box, Braces, CheckCircle2, CircleDot, LayoutDashboard, MessageSquare, Radio, Route } from 'lucide-react'
import { api } from '@/api/client'
import type { Provider, ProviderModel } from '@/api/types'

export default function Home() {
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Provider[]>('/api/providers') })
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ProviderModel[]>('/api/models') })
  const providerRows = providers.data ?? []
  const modelRows = models.data ?? []
  const enabledProviders = providerRows.filter((provider) => provider.enabled).length
  const enabledModels = modelRows.filter((model) => model.enabled).length
  const setupReady = enabledProviders > 0 && enabledModels > 0

  const setupSteps: Array<{ number: string; title: string; description: string; to: string; icon: LucideIcon }> = [
    { number: '01', title: '连接', description: '添加上游 Provider', to: '/providers', icon: LayoutDashboard },
    { number: '02', title: '整理', description: '导入并启用模型', to: '/models', icon: Box },
    { number: '03', title: '验证', description: '发起一次真实对话', to: '/playground', icon: MessageSquare },
  ]

  return (
    <div className="page-shell space-y-10">
      <section className="relative overflow-hidden border-b border-foreground/10 pb-10 pt-2">
        <div className="pointer-events-none absolute -right-5 -top-16 select-none font-mono text-[160px] font-medium leading-none tracking-[-0.15em] text-foreground/[.035] sm:text-[220px]">01</div>
        <div className="relative max-w-4xl">
          <div className="eyebrow mb-5 flex items-center gap-2"><span className="status-dot" /> 控制台 / 系统总览</div>
          <h1 className="text-5xl font-extrabold leading-[.94] tracking-[-0.07em] sm:text-7xl">每一次请求，<br /><span className="text-muted-foreground">都值得被看见。</span></h1>
          <p className="mt-7 max-w-xl text-sm leading-7 text-muted-foreground">原生透传的 LLM 聚合网关。连接上游、整理映射，在一个安静而有力的工作台里观察每一次路由。</p>
          <div className="mt-8 flex flex-wrap gap-3"><Link to="/playground" className="group inline-flex h-11 items-center gap-3 rounded-md bg-primary px-5 text-xs font-bold text-primary-foreground transition-transform hover:-translate-y-0.5">打开 Playground <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></Link><Link to="/providers" className="inline-flex h-11 items-center gap-3 rounded-md border border-foreground/15 px-5 text-xs font-bold transition-colors hover:bg-muted">管理连接 <LayoutDashboard className="h-4 w-4" /></Link></div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="连接节点" value={providers.isLoading ? '—' : providerRows.length} detail={`${enabledProviders} 个已启用`} icon={Radio} accent="lime" />
        <Metric label="可用模型" value={models.isLoading ? '—' : enabledModels} detail={`${modelRows.length} 个已发现`} icon={Box} accent="cyan" />
        <Metric label="路由状态" value="LIVE" detail="原生协议透传" icon={Route} accent="lime" />
        <Metric label="协议支持" value="02" detail="OpenAI / Anthropic" icon={Braces} accent="cyan" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <div className="console-surface"><div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4"><div><div className="eyebrow">System map</div><h2 className="mt-1 text-base font-bold tracking-[-0.04em]">把网关配置成你的工作流</h2></div><Activity className="h-5 w-5 text-muted-foreground" /></div><div className="grid gap-0 sm:grid-cols-3">{setupSteps.map(({ number, title, description, to, icon: Icon }) => <Link key={to} to={to} className="group border-b border-foreground/10 p-5 transition-colors hover:bg-muted/45 sm:border-b-0 sm:border-r last:border-r-0"><div className="flex items-center justify-between"><span className="font-mono text-[10px] text-muted-foreground">{number}</span><ArrowUpRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:-translate-y-1 group-hover:translate-x-1" /></div><Icon className="mt-12 h-5 w-5 text-primary" /><div className="mt-5 text-sm font-bold">{title}</div><div className="mt-2 text-xs leading-5 text-muted-foreground">{description}</div></Link>)}</div></div>
        <div className="relative overflow-hidden rounded-lg bg-primary p-5 text-primary-foreground"><div className="signal-line absolute inset-0 opacity-60" /><div className="relative flex items-start justify-between"><div><div className="eyebrow text-primary-foreground/55">Protocol surface</div><h2 className="mt-2 text-2xl font-extrabold tracking-[-0.06em]">原生，才是默认。</h2></div><CheckCircle2 className="h-5 w-5 text-accent" /></div><p className="relative mt-16 max-w-xs text-sm leading-6 text-primary-foreground/70">请求体保持原样，仅在路由成功后替换 `model` 字段。每一次调用都可追踪、可审计、可复现。</p><div className="relative mt-8 space-y-3 font-mono text-[10px] text-primary-foreground/70"><div className="flex items-center gap-2"><CircleDot className="h-3 w-3 text-accent" /> /openai/v1/chat/completions</div><div className="flex items-center gap-2"><CircleDot className="h-3 w-3 text-accent" /> /anthropic/v1/messages</div></div></div>
      </section>

      {!setupReady && !providers.isLoading && !models.isLoading && <div className="notice notice-success"><Activity className="mt-0.5 h-4 w-4 shrink-0" /><span>还没有完整的路由链路。先添加 Provider，再导入模型，即可在 Playground 发起请求。</span><Link to="/providers" className="ml-auto shrink-0 font-semibold underline underline-offset-4">开始配置</Link></div>}
    </div>
  )
}

function Metric({ label, value, detail, icon: Icon, accent }: { label: string; value: string | number; detail: string; icon: LucideIcon; accent: 'lime' | 'cyan' }) {
  return <div className="group rounded-lg border border-foreground/10 bg-card/70 p-4 transition-transform hover:-translate-y-0.5"><div className="flex items-center justify-between"><span className="eyebrow">{label}</span><Icon className={`h-4 w-4 ${accent === 'lime' ? 'text-primary' : 'text-[hsl(var(--info))]'}`} /></div><div className="mt-7 text-3xl font-extrabold tracking-[-0.07em]">{value}</div><div className="mt-2 font-mono text-[10px] text-muted-foreground">{detail}</div></div>
}
