/** 完全可见的时间。之后才开始淡出。 */
export const NOTICE_HOLD_MS = 5_000

/** 后半段淡出时长，与样式里 notice-fade 的 5s 对齐。 */
export const NOTICE_FADE_MS = 5_000

/** 手动关闭时的淡出时长，避免再等满 5 秒。 */
export const NOTICE_DISMISS_MS = 400

export type TimeoutClock = {
  setTimeout: (handler: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
}

export type NoticeRecord<T> = T & { id: number; leaving: boolean; fadeMs: number }

type Listener = () => void

/**
 * 一条提示先完全显示 5 秒，再花 5 秒淡出，结束后移除。
 * 手动关闭会立刻用较短的淡出，并取消尚未触发的停留计时。
 */
export function createNoticeQueue<T>(clock: TimeoutClock) {
  let seq = 0
  let items: Array<NoticeRecord<T>> = []
  const timers = new Map<number, number>()
  const listeners = new Set<Listener>()

  function emit() {
    for (const listener of listeners) listener()
  }

  function arm(id: number, ms: number, run: () => void) {
    const previous = timers.get(id)
    if (previous != null) clock.clearTimeout(previous)
    timers.set(id, clock.setTimeout(run, ms))
  }

  function leave(id: number, fadeMs = NOTICE_FADE_MS) {
    const current = items.find((item) => item.id === id)
    if (!current || current.leaving) return
    items = items.map((item) => (item.id === id ? { ...item, leaving: true, fadeMs } : item))
    emit()
    arm(id, fadeMs, () => {
      timers.delete(id)
      items = items.filter((item) => item.id !== id)
      emit()
    })
  }

  function drop(id: number) {
    const previous = timers.get(id)
    if (previous != null) clock.clearTimeout(previous)
    timers.delete(id)
    if (!items.some((item) => item.id === id)) return
    items = items.filter((item) => item.id !== id)
    emit()
  }

  return {
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getItems() {
      return items
    },
    push(payload: T) {
      const id = ++seq
      items = [...items, { ...payload, id, leaving: false, fadeMs: NOTICE_FADE_MS }]
      emit()
      arm(id, NOTICE_HOLD_MS, () => leave(id))
      return id
    },
    leave,
    drop,
    dispose() {
      for (const handle of timers.values()) clock.clearTimeout(handle)
      timers.clear()
    },
  }
}
