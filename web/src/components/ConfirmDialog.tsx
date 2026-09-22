import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
}

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void }

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  destructive,
  pending,
  onCancel,
  onConfirm,
}: ConfirmOptions & {
  open: boolean
  pending?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>取消</Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={pending}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 把 window.confirm 换成与 Settings 一致的确认对话框；返回 true 表示用户确认。 */
export function useConfirm() {
  const [current, setCurrent] = useState<PendingConfirm | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setCurrent({ ...options, resolve })
    })
  }, [])

  const confirmDialog = current ? (
    <ConfirmDialog
      open
      title={current.title}
      description={current.description}
      confirmLabel={current.confirmLabel}
      destructive={current.destructive}
      onCancel={() => {
        current.resolve(false)
        setCurrent(null)
      }}
      onConfirm={() => {
        current.resolve(true)
        setCurrent(null)
      }}
    />
  ) : null

  return { confirm, confirmDialog }
}
