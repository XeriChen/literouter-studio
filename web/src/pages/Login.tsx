import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { Activity, ArrowRight, Eye, EyeOff, KeyRound, LockKeyhole, Radio, Sparkles } from 'lucide-react'
import { api, getToken, setToken } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function Login() {
  const navigate = useNavigate()
  const [token, setTokenValue] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // 已有 token 直接进入工作台，避免登录页闪烁
  if (getToken()) return <Navigate to="/" replace />

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!token.trim()) return
    setLoading(true)
    setError(null)
    try {
      const data = await api<{ token: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim() }),
      })
      setToken(data.token)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="surface-grid relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-5 sm:p-10">
      {/* 氛围发光层 */}
      <div className="pointer-events-none absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-primary/10 blur-[120px]" />
      <div className="pointer-events-none absolute right-10 bottom-1/4 h-96 w-96 rounded-full bg-accent/15 blur-[140px]" />

      {/* 右侧装饰区域（宽屏可见） */}
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[44%] border-l border-foreground/10 lg:block bg-gradient-to-b from-primary/[.03] to-transparent">
        <div className="absolute left-12 top-1/4 font-mono text-[11px] leading-8 text-muted-foreground/70">
          {[
            '01  ROUTER_READY // PASSTHROUGH',
            '02  TRUSTED_LOCAL_NETWORK',
            '03  GATEWAY_TOKEN_AUTH',
            '04  SESSION_PERSIST_LOCAL',
            '05  OPENAI_&_ANTHROPIC_NATIVE',
          ].map((line) => (
            <div key={line} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-primary/60" />
              <span>{line}</span>
            </div>
          ))}
        </div>
        <div className="absolute bottom-20 right-14 text-right">
          <div className="eyebrow mb-2">native passthrough</div>
          <div className="text-7xl font-black tracking-[-0.08em] text-foreground/[.06]">LR / 01</div>
        </div>
      </div>

      {/* 登录卡片区 */}
      <div className="relative z-10 w-full max-w-[450px] lg:mr-[16vw]">
        <div className="glass-card rounded-2xl border border-foreground/10 p-7 sm:p-9 shadow-2xl backdrop-blur-2xl">
          <div className="mb-10 flex items-center gap-3">
            <div className="pulse-radar flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <Activity className="h-5 w-5" strokeWidth={2.5} />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-base font-extrabold tracking-[-0.04em]">LITEROUTER</span>
                <span className="rounded bg-accent/20 px-1 py-0.2 font-mono text-[9px] font-bold text-accent">
                  v0.1
                </span>
              </div>
              <div className="eyebrow mt-0.5">gateway / studio</div>
            </div>
          </div>

          <div className="mb-8">
            <div className="eyebrow mb-2.5 flex items-center gap-2">
              <LockKeyhole className="h-3.5 w-3.5 text-primary" /> 本地安全控制台
            </div>
            <h1 className="text-3xl font-extrabold leading-[1.05] tracking-[-0.05em] sm:text-4xl text-foreground">
              进入你的<br />
              <span className="bg-gradient-to-r from-primary to-emerald-400 bg-clip-text text-transparent">
                路由工作台。
              </span>
            </h1>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              使用网关 Token 登录。Token 仅保存在当前浏览器本地，直接与本地网关通信。
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="token" className="sr-only">
                Gateway Token
              </Label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="token"
                  type={showToken ? 'text' : 'password'}
                  placeholder="输入 gateway token"
                  value={token}
                  onChange={(event) => setTokenValue(event.target.value)}
                  autoFocus
                  className="h-12 pl-10 pr-10 font-mono text-sm bg-background/80 rounded-xl"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 transition-colors"
                  title={showToken ? '隐藏 Token' : '显示 Token'}
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="notice notice-error border border-white/[0.14] px-3.5 py-2.5 rounded-lg text-xs">
                <Radio className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button
              type="submit"
              className="h-12 w-full rounded-xl text-sm font-bold shadow-md shadow-primary/20 hover:shadow-lg transition-all"
              disabled={loading || !token.trim()}
            >
              {loading ? (
                '正在验证...'
              ) : (
                <>
                  进入工作台 <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </form>

          <div className="mt-8 flex items-center justify-between border-t border-foreground/10 pt-4 font-mono text-[10px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span className="status-dot" />
              <span>LOCAL ONLY</span>
            </div>
            <span className="text-foreground/20">/</span>
            <span>TRUSTED NETWORK</span>
          </div>
        </div>
      </div>
    </div>
  )
}
