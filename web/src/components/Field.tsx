import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'

/** 表单字段：Label 与控件通过 id/htmlFor 关联，保证读屏可聚焦到输入框。 */
export function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
