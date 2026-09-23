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

/** 把 window.confirm 换成与 Settings 一致的确认对话框；返回 true 表示用户确认。并发调用会排队，不会覆盖前一个 resolve。 */
export function useConfirm() {
  const [queue, setQueue] = useState<PendingConfirm[]>([])
  const current = queue[0] ?? null

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setQueue((prev) => [...prev, { ...options, resolve }])
    })
  }, [])

  const settle = useCallback((ok: boolean) => {
    setQueue((prev) => {
      const [head, ...rest] = prev
      head?.resolve(ok)
      return rest
    })
  }, [])

  const confirmDialog = current ? (
    <ConfirmDialog
      open
      title={current.title}
      description={current.description}
      confirmLabel={current.confirmLabel}
      destructive={current.destructive}
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  ) : null

  return { confirm, confirmDialog }
}
