import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, X } from 'lucide-react'

export interface NoticeItem {
  id: number
  ok: boolean
  message: string
  leaving?: boolean
  fadeMs?: number
  meta?: string
}

/** 统一操作提示：与 Providers/Settings 的 notice 实色横幅一致（成功/失败 + 可关闭 + 淡出）。 */
export function NoticeStack({
  items,
  onDismiss,
  role = 'status',
}: {
  items: NoticeItem[]
  onDismiss: (id: number) => void
  role?: 'status' | 'alert'
}) {
  if (!items.length) return null
  // portal 到 body：.page-shell 的 animate-rise-in 会让内部 fixed 相对页面定位
  return createPortal(
    <div className="notice-layer flex-col gap-2 px-4" role={role}>
      {items.map((item) => (
        <div
          key={item.id}
          className={`notice border border-white/[0.14] px-3.5 py-2.5 ${item.ok ? 'notice-success' : 'notice-error'}${item.leaving ? ' is-leaving' : ''}`}
          style={item.leaving && item.fadeMs ? { animationDuration: `${item.fadeMs}ms` } : undefined}
        >
          {item.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{item.message}</span>
          {item.meta ? <span className="shrink-0 self-center font-mono text-[10px] opacity-70">{item.meta}</span> : null}
          <button type="button" aria-label="关闭提示" onClick={() => onDismiss(item.id)} className="icon-button h-6 w-6">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
