import { Crosshair, X } from 'lucide-react'

/** 搜索跳转后的定位标记：说明本次定位到了哪个对象，并与命中项的跳动高亮同步存在。 */
export function SpotlightHint({
  label,
  onDismiss,
}: {
  label: string
  onDismiss: () => void
}) {
  return (
    <div role="status" className="spotlight-chip">
      <Crosshair className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
      <span className="pulse-radar h-1.5 w-1.5 shrink-0 rounded-full bg-current text-accent" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
      <button type="button" aria-label="关闭定位提示" title="关闭定位提示" onClick={onDismiss} className="icon-button">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
