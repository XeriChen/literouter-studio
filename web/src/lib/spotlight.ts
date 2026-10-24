import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

/** 搜索跳转携带的关键字参数：用于预填目标页面的搜索框 */
export const SEARCH_PARAM = 'q'
/** 搜索跳转携带的定位目标 key：命中项会以高亮跳动标记 */
export const SPOTLIGHT_PARAM = 'spotlight'

/** 目标元素出现后的高亮持续时长 */
const DEFAULT_HOLD_MS = 2600
/** 兜底时长：目标迟迟未渲染时也要收掉高亮，避免一直挂着 */
const MAX_WAIT_MS = 6000

export interface SearchSpotlight {
  /** 跳转带来的搜索关键字，用于预填页面搜索框 */
  query: string
  /** 本次要定位的目标 key，没有跳转标记时为 null */
  target: string | null
  /** 是否处于高亮期 */
  active: boolean
  /** 每次定位自增，可作为 key 强制重启 CSS 动画 */
  pulseId: number
  /** 该 key 是否为本次定位目标 */
  isTarget: (key: string) => boolean
  /**
   * 绑到命中元素的 ref。同一目标可绑定多个形态（桌面表格行 / 移动卡片），
   * 滚动时取当前可见的那个；未命中时返回 undefined。
   */
  bindTarget: (key: string, slot?: string) => ((element: HTMLElement | null) => void) | undefined
  /** 提前结束高亮 */
  clear: () => void
}

/** 拼出带跳转参数的地址：目标页面 + 预填关键字 + 定位目标 */
export function buildJumpPath(
  path: string,
  options: { query?: string; spotlight?: string; extra?: Record<string, string> },
): string {
  const params = new URLSearchParams(options.extra ?? {})
  if (options.query) params.set(SEARCH_PARAM, options.query)
  if (options.spotlight) params.set(SPOTLIGHT_PARAM, options.spotlight)
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

/**
 * 搜索跳转后的「命中定位」能力：消费一次性的关键字与定位参数，
 * 目标元素挂载后滚动到视口中央并高亮跳动一段时间。
 */
export function useSearchSpotlight(holdMs = DEFAULT_HOLD_MS): SearchSpotlight {
  const [searchParams, setSearchParams] = useSearchParams()
  // 首次渲染同步取值，页面可据此预填搜索框而不出现「先空后填」的闪烁
  const [seed] = useState(() => ({
    query: searchParams.get(SEARCH_PARAM) ?? '',
    target: searchParams.get(SPOTLIGHT_PARAM),
  }))
  const [query, setQuery] = useState(seed.query)
  const [target, setTarget] = useState(seed.target)
  const [active, setActive] = useState(seed.target !== null)
  const [pulseId, setPulseId] = useState(0)
  const [nodes, setNodes] = useState<Record<string, HTMLElement>>({})

  // 消费参数并从地址栏移除：刷新或复制链接不会重复播放定位动效。
  // 同一页面内再次跳转时组件不会重挂载，所以这里按参数变化重新触发定位。
  useEffect(() => {
    if (!searchParams.has(SEARCH_PARAM) && !searchParams.has(SPOTLIGHT_PARAM)) return
    const nextQuery = searchParams.get(SEARCH_PARAM)
    const nextTarget = searchParams.get(SPOTLIGHT_PARAM)
    if (nextQuery !== null) setQuery(nextQuery)
    if (nextTarget !== null) {
      setTarget(nextTarget)
      setActive(true)
      setPulseId((current) => current + 1)
    }
    const next = new URLSearchParams(searchParams)
    next.delete(SEARCH_PARAM)
    next.delete(SPOTLIGHT_PARAM)
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const hasNode = Object.keys(nodes).length > 0
  useEffect(() => {
    if (!active) return
    // 目标已挂载即开始倒计时；目标迟迟未出现时走兜底时长
    const timer = setTimeout(() => setActive(false), hasNode ? holdMs : MAX_WAIT_MS)
    return () => clearTimeout(timer)
  }, [active, hasNode, holdMs, pulseId])

  useEffect(() => {
    if (!active || !hasNode) return
    const candidates = Object.values(nodes)
    const visible = candidates.find((node) => node.offsetParent !== null) ?? candidates[0]
    if (!visible) return
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    visible.scrollIntoView({ behavior, block: 'center', inline: 'nearest' })
  }, [active, hasNode, nodes, pulseId])

  // ref 身份保持稳定：每次渲染都换新函数会让 React 反复 detach/attach，导致重复滚动
  const slotRefs = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const bindRef = useCallback((slot: string) => {
    const cache = slotRefs.current
    const cached = cache.get(slot)
    if (cached) return cached
    const ref = (element: HTMLElement | null) => {
      setNodes((current) => {
        const next = { ...current }
        if (element) next[slot] = element
        else delete next[slot]
        return next
      })
    }
    cache.set(slot, ref)
    return ref
  }, [])

  const isTarget = useCallback((key: string) => active && target !== null && key === target, [active, target])
  const bindTarget = useCallback(
    (key: string, slot = 'default') => (isTarget(key) ? bindRef(slot) : undefined),
    [bindRef, isTarget],
  )
  const clear = useCallback(() => setActive(false), [])

  return { query, target, active, pulseId, isTarget, bindTarget, clear }
}
