import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createNoticeQueue, NOTICE_DISMISS_MS, NOTICE_FADE_MS, type NoticeRecord } from '@/lib/notice-lifetime'

/** 单条提示：换内容会重新计时。前 5 秒不淡化，后 5 秒淡出；手动关闭则短淡出。 */
export function useTimedNotice(token: string | null, onGone: () => void) {
  const [queue] = useState(() => createNoticeQueue<{ token: string }>(window))
  const items = useSyncExternalStore(queue.subscribe, queue.getItems, queue.getItems)
  const onGoneRef = useRef(onGone)
  useEffect(() => {
    onGoneRef.current = onGone
  }, [onGone])
  const armed = useRef<string | null>(null)

  useEffect(() => {
    if (token == null) {
      armed.current = null
      for (const item of [...queue.getItems()]) queue.drop(item.id)
      return
    }
    // 同一条提示淡出后队列会变空。这里不能再次入队，否则会重新计时。
    if (armed.current === token) return
    for (const item of [...queue.getItems()]) queue.drop(item.id)
    queue.push({ token })
    armed.current = token
  }, [token, queue])

  useEffect(() => {
    if (token == null || armed.current !== token) return
    if (queue.getItems().some((item) => item.token === token)) return
    onGoneRef.current()
  }, [items, token, queue])

  const current = items.find((item) => item.token === token)

  function requestLeave() {
    if (current) queue.leave(current.id, NOTICE_DISMISS_MS)
  }

  return { leaving: current?.leaving ?? false, fadeMs: current?.fadeMs ?? NOTICE_FADE_MS, requestLeave }
}

export function useTimedToasts<T>() {
  const [queue] = useState(() => createNoticeQueue<T>(window))
  const items = useSyncExternalStore(queue.subscribe, queue.getItems, queue.getItems)

  useEffect(() => () => queue.dispose(), [queue])

  return {
    items: items as Array<NoticeRecord<T>>,
    push: queue.push,
    leave: (id: number) => queue.leave(id, NOTICE_DISMISS_MS),
  }
}
