import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, ArrowRight, KeyRound, LockKeyhole, Radio } from 'lucide-react'
import { api, setToken } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function Login() {
  const navigate = useNavigate()
  const [token, setTokenValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!token.trim()) return
    setLoading(true); setError(null)
    try {
      const data = await api<{ token: string }>('/api/login', { method: 'POST', body: JSON.stringify({ token: token.trim() }) })
      setToken(data.token); navigate('/', { replace: true })
    } catch (err) { setError(err instanceof Error ? err.message : '登录失败') } finally { setLoading(false) }
  }
  return <div className="surface-grid relative flex min-h-screen items-center overflow-hidden bg-background p-5 sm:p-10"><div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[46%] border-l border-foreground/10 lg:block"><div className="absolute inset-0 bg-primary/[.025]" /><div className="absolute left-12 top-1/4 font-mono text-[10px] leading-7 text-muted-foreground/60">{['01  ROUTER_READY', '02  TRUSTED_NETWORK', '03  TOKEN_REQUIRED', '04  SESSION_LOCAL'].map((line) => <div key={line}>{line}</div>)}</div><div className="absolute bottom-20 right-14 text-right"><div className="eyebrow mb-3">native passthrough</div><div className="text-6xl font-extrabold tracking-[-0.08em] text-foreground/[.08]">LR / 01</div></div></div><div className="relative z-10 w-full max-w-[440px] lg:ml-[8vw]"><div className="mb-12 flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_30px_hsl(var(--accent)/.2)]"><Activity className="h-5 w-5" /></div><div><div className="text-sm font-extrabold tracking-[-0.04em]">LITEROUTER</div><div className="eyebrow mt-1">gateway / studio</div></div></div><div className="mb-8"><div className="eyebrow mb-3 flex items-center gap-2"><LockKeyhole className="h-3.5 w-3.5" /> 本地控制台</div><h1 className="text-5xl font-extrabold leading-[.94] tracking-[-0.07em]">进入你的<br /><span className="text-muted-foreground">路由工作台。</span></h1><p className="mt-5 text-sm leading-6 text-muted-foreground">使用网关 Token 登录。Token 只在当前浏览器本地保存。</p></div><form onSubmit={onSubmit} className="space-y-4"><div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="token" type="password" placeholder="输入 gateway token" value={token} onChange={(event) => setTokenValue(event.target.value)} autoFocus className="h-12 pl-10 font-mono" /></div>{error && <div className="notice notice-error"><Radio className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}<Button type="submit" className="h-12 w-full" disabled={loading || !token.trim()}>{loading ? '正在验证...' : <>进入工作台 <ArrowRight className="h-4 w-4" /></>}</Button></form><div className="mt-10 flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><span className="status-dot" /> LOCAL ONLY <span className="mx-1 text-foreground/20">/</span> TRUSTED NETWORK</div></div></div>
}
