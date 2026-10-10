import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot,
  Check,
  Copy,
  CornerDownLeft,
  SendHorizontal,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  User,
  Zap,
} from 'lucide-react'
import { authHeaders } from '@/api/client'
import type { ModelAlias } from '@/api/types'
import { useBottomInset } from '@/hooks/useBottomInset'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Textarea } from '@/components/ui/textarea'
import { SseDeltaParser } from '@/lib/sse'
import { copyText } from '@/lib/clipboard'
import { DEFAULT_PROMPT } from '@/lib/prompts'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface ChatUIProps {
  protocol: 'openai' | 'anthropic'
  alias: ModelAlias | null
}

const QUICK_PROMPTS = [
  '用 TypeScript 实现一个支持防抖和节流的高阶函数',
  '输出一段用于大模型配置的 JSON 样例结构',
  '简述轻量 LLM 网关原生透传设计的核心优势',
]

function storageKey(protocol: string, aliasName: string): string {
  return `chat:${protocol}:${aliasName}`
}

function newMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Anthropic 要求 messages 严格交替 user/assistant 且以 user 开头。
 * 连续同 role 合并，避免上游 400 拒绝。
 */
function normalizeAnthropicMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${message.content}`
    } else {
      merged.push({ role: message.role, content: message.content })
    }
  }
  while (merged.length && merged[0]!.role !== 'user') merged.shift()
  return merged
}

export function ChatUI({ protocol, alias }: ChatUIProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomInset = useBottomInset()

  // ——— 持久化：按 protocol+alias 存取对话 ———
  const persistKey = alias ? storageKey(protocol, alias.alias_name) : ''

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    if (!persistKey) {
      setMessages([])
      return
    }
    try {
      const saved = localStorage.getItem(persistKey)
      const parsed: unknown = saved ? JSON.parse(saved) : []
      setMessages(
        Array.isArray(parsed)
          ? parsed
            .filter(
              (message): message is { id?: string; role: 'user' | 'assistant'; content: string } =>
                typeof message === 'object'
                && message !== null
                && ((message as { role?: unknown }).role === 'user' || (message as { role?: unknown }).role === 'assistant')
                && typeof (message as { content?: unknown }).content === 'string',
            )
            .map((message) => ({
              id: typeof message.id === 'string' && message.id ? message.id : newMessageId(),
              role: message.role,
              content: message.content,
            }))
          : [],
      )
    } catch {
      setMessages([])
    }
  }, [persistKey])

  const persist = useCallback((msgs: ChatMessage[]) => {
    if (!persistKey) return
    try {
      localStorage.setItem(persistKey, JSON.stringify(msgs))
    } catch {
      // ignore quota errors
    }
  }, [persistKey])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streaming])

  // 清除当前对话
  const clearChat = useCallback(() => {
    setMessages([])
    if (persistKey) localStorage.removeItem(persistKey)
  }, [persistKey])

  /**
   * text 为字符串时直接以该文案发起（Playground 一键问话，含 DEFAULT_PROMPT）；
   * 其余情况取输入框内容。用 typeof 判断而不是 truthy，避免 onClick={send}
   * 这类写法把事件对象传进来时静默走错分支。
   */
  const send = useCallback(async (text?: string) => {
    const explicit = typeof text === 'string'
    const content = (explicit ? text : input).trim()
    if (!content || !alias || streaming) return

    const userMsg: ChatMessage = { id: newMessageId(), role: 'user', content }
    const history = [...messages, userMsg]
    setMessages(history)
    persist(history)
    // 一键问话不动用户输入框里的草稿；输入框发送时才清空
    if (!explicit) setInput('')
    setStreaming(true)

    const ac = new AbortController()
    abortRef.current = ac

    const path = protocol === 'openai' ? '/openai/v1/chat/completions' : '/anthropic/v1/messages'
    const payload: Record<string, unknown> = {
      model: alias.alias_name,
      stream: true,
    }
    if (protocol === 'anthropic') {
      payload.messages = normalizeAnthropicMessages(history)
      payload.max_tokens = 4096
    } else {
      payload.messages = history.map((m) => ({ role: m.role, content: m.content }))
    }

    let reply = ''
    let rafId: number | null = null
    let pendingReply = ''

    // 使用 rAF 节流：批量积累 delta，每帧最多更新一次 state
    const flush = () => {
      if (pendingReply) {
        reply = pendingReply
        setMessages([...history, { id: assistantDraftId, role: 'assistant', content: reply }])
      }
      rafId = null
    }
    const assistantDraftId = newMessageId()

    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
        signal: ac.signal,
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        const errMsg = `HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`
        const errorMsg: ChatMessage = { id: assistantDraftId, role: 'assistant', content: `错误：${errMsg}` }
        const updated = [...history, errorMsg]
        setMessages(updated)
        persist(updated)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('no response body')

      const decoder = new TextDecoder()
      const parser = new SseDeltaParser(protocol)
      const appendDeltas = (deltas: string[]) => {
        for (const text of deltas) {
          pendingReply = (pendingReply || reply) + text
          if (rafId === null) rafId = requestAnimationFrame(flush)
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        appendDeltas(parser.push(decoder.decode(value, { stream: true })))
      }
      appendDeltas(parser.push(decoder.decode()))
      appendDeltas(parser.finish())
      // flush 残留
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (pendingReply) reply = pendingReply

      const finalMsgs = [...history, { id: assistantDraftId, role: 'assistant' as const, content: reply || '(空回复)' }]
      setMessages(finalMsgs)
      persist(finalMsgs)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // 用户主动停止，保留已收到的部分回复
        if (reply || pendingReply) {
          if (pendingReply) reply = pendingReply
          const partial = [...history, { id: assistantDraftId, role: 'assistant' as const, content: reply + ' [已中断]' }]
          setMessages(partial)
          persist(partial)
        }
      } else {
        const reason = err instanceof Error ? err.message : String(err)
        const partialReply = pendingReply || reply
        const errorMsg: ChatMessage = {
          id: assistantDraftId,
          role: 'assistant',
          content: partialReply ? `${partialReply}\n\n[请求失败：${reason}]` : `请求失败：${reason}`,
        }
        const updated = [...history, errorMsg]
        setMessages(updated)
        persist(updated)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [input, alias, messages, streaming, protocol, persist])

  useEffect(() => () => abortRef.current?.abort(), [])

  const hasMessages = messages.length > 0

  return (
    <div className="flex h-full flex-col">
      {/* 消息历史滚动区 */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6" aria-live="polite">
        {!hasMessages && (
          <div className="flex h-full flex-col items-center justify-center gap-5 p-4 text-center">
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-sm border border-primary/20">
              <Sparkles className="h-7 w-7" />
              <span className="pulse-radar absolute -right-1 -top-1 h-3 w-3 rounded-full bg-primary" />
            </div>

            <div className="max-w-md">
              <h3 className="text-base font-extrabold tracking-tight text-foreground">
                {alias ? `已就绪：${alias.alias_name}` : '请先在上方选择一个模型映射'}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {alias
                  ? `向本地网关发送真实流式请求，由网关原生透传至 ${alias.provider_name}。`
                  : '添加 Provider 并导入模型后，即可在此验证真实流式对话。'}
              </p>
            </div>

            {alias && (
              <div className="flex flex-col items-center gap-3">
                <Button
                  variant="default"
                  size="sm"
                  disabled={streaming}
                  onClick={() => void send(DEFAULT_PROMPT)}
                  title={`一键提问：${DEFAULT_PROMPT}`}
                  aria-label={`一键提问：${DEFAULT_PROMPT}`}
                  className="rounded-full px-5 py-2 text-xs font-bold shadow-md shadow-primary/20 hover:shadow-lg"
                >
                  <Zap className="h-3.5 w-3.5 fill-current" />
                  {DEFAULT_PROMPT}
                </Button>

                {/* 快捷示例推荐标签 */}
                <div className="flex flex-wrap justify-center gap-1.5 max-w-lg mt-2">
                  {QUICK_PROMPTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      disabled={streaming}
                      onClick={() => void send(q)}
                      className="rounded-full border border-foreground/10 bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground transition-all duration-150 hover:border-foreground/25 hover:bg-muted/80 hover:text-foreground"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex items-start gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {m.role === 'assistant' && (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 border border-primary/20 text-primary shadow-xs mt-1">
                <Bot className="h-4 w-4" />
              </div>
            )}

            <div
              className={`group relative max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed transition-all duration-150 ${
                m.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-tr-xs shadow-md shadow-primary/10'
                  : 'glass-card rounded-tl-xs shadow-xs text-foreground'
              }`}
            >
              {m.role === 'user' ? (
                <div className="whitespace-pre-wrap font-medium">{m.content}</div>
              ) : (
                <>
                  <div className="mb-1.5 flex items-center gap-2 border-b border-foreground/5 pb-1">
                    <span className="font-mono text-[10px] font-bold text-primary">
                      {alias?.alias_name || 'ASSISTANT'}
                    </span>
                    {alias?.provider_name && (
                      <span className="font-mono text-[9px] text-muted-foreground">
                        via {alias.provider_name}
                      </span>
                    )}
                  </div>
                  <MarkdownRenderer content={m.content} />
                  {streaming && messages[messages.length - 1]?.id === m.id && (
                    <span className="streaming-cursor" />
                  )}

                  <div className="mt-2 flex items-center justify-between border-t border-foreground/5 pt-1.5">
                    <span className="font-mono text-[9px] text-muted-foreground/70">
                      {m.content.length} 字符
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void copyText(m.content)
                        setCopiedId(m.id)
                        setTimeout(() => setCopiedId((curr) => (curr === m.id ? null : curr)), 1500)
                      }}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-60 transition-all hover:opacity-100 hover:bg-muted"
                      title="复制消息内容"
                      aria-label="复制消息内容"
                    >
                      {copiedId === m.id ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-500" />
                          <span className="text-emerald-500">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          <span>复制</span>
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>

            {m.role === 'user' && (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-foreground mt-1">
                <User className="h-4 w-4" />
              </div>
            )}
          </div>
        ))}

        {streaming && messages.at(-1)?.role !== 'assistant' && (
          <div className="flex items-start gap-3 justify-start">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 border border-primary/20 text-primary mt-1">
              <Bot className="h-4 w-4" />
            </div>
            <div className="glass-card rounded-2xl rounded-tl-xs px-4 py-2.5 text-xs text-muted-foreground flex items-center gap-2">
              <span className="pulse-radar h-1.5 w-1.5 rounded-full bg-primary" />
              <span>正在建立连接并生成回复...</span>
            </div>
          </div>
        )}
      </div>

      {/* 底部输入框与工具栏 */}
      <div
        className="border-t border-foreground/10 bg-card/60 p-3 sm:p-4 backdrop-blur-md"
        style={bottomInset > 0 ? { paddingBottom: `calc(1rem + ${bottomInset}px)` } : undefined}
      >
        {/* 输入框上方的快捷提问提示条 */}
        {hasMessages && !streaming && (
          <div className="mb-2 flex items-center gap-2 overflow-x-auto pb-1">
            <span className="font-mono text-[10px] text-muted-foreground shrink-0">快捷提问:</span>
            <button
              type="button"
              onClick={() => void send(DEFAULT_PROMPT)}
              className="shrink-0 rounded-full border border-foreground/10 bg-muted/30 px-2.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              ⚡ {DEFAULT_PROMPT}
            </button>
            {QUICK_PROMPTS.slice(0, 2).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void send(q)}
                className="shrink-0 rounded-full border border-foreground/10 bg-muted/30 px-2.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors truncate max-w-[200px]"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2.5">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="输入消息，Enter 发送（Shift+Enter 换行）..."
            aria-label="消息输入"
            rows={2}
            className="resize-none bg-background/80 shadow-xs focus-visible:ring-1 focus-visible:ring-primary rounded-xl"
          />

          {hasMessages && !streaming && (
            <Button
              variant="outline"
              size="icon"
              onClick={clearChat}
              title="清除对话历史"
              aria-label="清除对话"
              className="h-10 w-10 shrink-0 rounded-xl"
            >
              <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
            </Button>
          )}

          {streaming ? (
            <Button
              variant="destructive"
              size="icon"
              aria-label="停止生成"
              title="停止生成"
              onClick={() => abortRef.current?.abort()}
              className="h-10 w-10 shrink-0 rounded-xl animate-pulse"
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label="发送消息"
              title="发送消息"
              onClick={() => void send()}
              disabled={!input.trim() || !alias}
              className="h-10 w-10 shrink-0 rounded-xl shadow-md shadow-primary/20"
            >
              <SendHorizontal className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground px-1 font-mono">
          <span>{alias ? `${alias.alias_name} · ${protocol.toUpperCase()}` : '等待选择映射'}</span>
          <span>ENTER TO SEND / SHIFT+ENTER NEWLINE</span>
        </div>
      </div>
    </div>
  )
}
