/**
 * 复制文本到剪贴板。
 * navigator.clipboard 仅在安全上下文（HTTPS / localhost）可用，网关按设计运行在明文 HTTP 局域网下，
 * 因此这里在不可用或写入失败时回退到 textarea + execCommand，保证按钮在局域网访问时也能工作。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒或页面失焦时回退到旧方案
    }
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
