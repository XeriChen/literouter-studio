import { useEffect, useState } from 'react'

/**
 * 测量浏览器自身 UI（iOS Safari / Android Chrome 底部工具栏、虚拟键盘）对布局视口
 * 底部的遮挡高度。移动端浏览器上 `position: fixed; bottom: 0` 的元素锚定的是
 * 最大布局视口，工具栏展开时会被压在浏览器 UI 下面，下滑收起后才可见；
 * 用 visualViewport 动态补偿，可让 fixed 底栏始终落在可见区域内。
 *
 * 返回值：被遮挡的像素高度（桌面环境恒为 0，有 150px 上限防缩放误判）。
 */
export function useBottomInset(max = 150) {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const hidden = Math.round(Math.min(max, Math.max(0, window.innerHeight - vv.height - vv.offsetTop)))
      setInset(hidden)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [max])

  return inset
}
