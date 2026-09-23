import { useCallback, useEffect, useRef, useState } from 'react'
import { SendHorizontal, Square, Trash2 } from 'lucide-react'
import { authHeaders } from '@/api/client'
import type { ModelAlias } from '@/api/types'
import { useBottomInset } from '@/hooks/useBottomInset'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Textarea } from '@/components/ui/textarea'
import { SseDeltaParser } from '@/lib/sse'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface ChatUIProps {
  protocol: 'openai' | 'anthropic'
  alias: ModelAlias | null
}

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
  }, [messages])

  // 清除当前对话
  const clearChat = useCallback(() => {
    setMessages([])
    if (persistKey) localStorage.removeItem(persistKey)
  }, [persistKey])

  const send = useCallback(async () => {
    if (!input.trim() || !alias || streaming) return

    const userMsg: ChatMessage = { id: newMessageId(), role: 'user', content: input.trim() }
    const history = [...messages, userMsg]
    setMessages(history)
    persist(history)
    setInput('')
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
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {!hasMessages && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            选择模型映射后开始对话
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
              }`}
            >
              {m.role === 'user' ? (
                <div className="whitespace-pre-wrap">{m.content}</div>
              ) : (
                <MarkdownRenderer content={m.content} />
              )}
            </div>
          </div>
        ))}
        {streaming && messages.at(-1)?.role !== 'assistant' && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-muted px-3 py-2 text-sm">思考中…</div>
          </div>
        )}
      </div>

      <div className="border-t p-4" style={bottomInset > 0 ? { paddingBottom: `calc(1rem + ${bottomInset}px)` } : undefined}>
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
            aria-label="消息输入"
            rows={2}
            className="resize-none"
          />
          {hasMessages && !streaming && (
            <Button variant="outline" size="icon" onClick={clearChat} title="清除对话" aria-label="清除对话">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          {streaming ? (
            <Button variant="outline" size="icon" aria-label="停止生成" title="停止生成" onClick={() => abortRef.current?.abort()}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="icon" aria-label="发送消息" title="发送消息" onClick={send} disabled={!input.trim() || !alias}>
              <SendHorizontal className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
