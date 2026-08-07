import { useEffect, useRef, useState } from 'react'
import { Loader2, SendHorizontal } from 'lucide-react'
import type { Provider, ProviderModel } from '@/api/types'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Textarea } from '@/components/ui/textarea'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatUIProps {
  protocol: 'openai' | 'anthropic'
  provider: Provider | null
  model: ProviderModel | null
}

const decoder = new TextDecoder()

function parseSSELine(buf: string, protocol: 'openai' | 'anthropic', onDelta: (text: string) => void): void {
  for (const line of buf.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (protocol === 'openai') {
      if (data === '[DONE]') continue
      try {
        const obj = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
        const text = obj.choices?.[0]?.delta?.content
        if (text) onDelta(text)
      } catch {
        // 忽略无法解析的块
      }
    } else {
      try {
        const obj = JSON.parse(data) as { type?: string; delta?: { text?: string } }
        if (obj.type === 'content_block_delta' && obj.delta?.text) onDelta(obj.delta.text)
      } catch {
        // 忽略
      }
    }
  }
}

export function ChatUI({ protocol, provider, model }: ChatUIProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 切换协议 / Provider / 模型时清空聊天记录
  useEffect(() => {
    setMessages([])
  }, [protocol, provider?.id, model?.model_id])

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send(prompt?: string) {
    const content = (prompt ?? input).trim()
    if (!content || streaming || !provider || !model) return
    setInput('')
    const history: ChatMessage[] = [...messages, { role: 'user', content }]
    setMessages(history)
    setStreaming(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const path = protocol === 'openai' ? '/openai/v1/chat/completions' : '/anthropic/v1/messages'
      const reqBody: Record<string, unknown> =
        protocol === 'openai'
          ? { model: model.model_id, messages: history.map((m) => ({ role: m.role, content: m.content })), stream: true }
          : { model: model.model_id, max_tokens: 1024, messages: history.map((m) => ({ role: m.role, content: m.content })), stream: true }
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(localStorage.getItem('llm_gateway_token') ? { authorization: `Bearer ${localStorage.getItem('llm_gateway_token')}` } : {}),
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      } as RequestInit)
      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => 'unknown error')
        throw new Error(`代理请求失败（${res.status}）：${err.slice(0, 200)}`)
      }
      const reader = res.body.getReader()
      let buf = ''
      let reply = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const newlineIdx = buf.lastIndexOf('\n')
        const complete = newlineIdx >= 0 ? buf.slice(0, newlineIdx + 1) : ''
        buf = newlineIdx >= 0 ? buf.slice(newlineIdx + 1) : buf
        parseSSELine(complete, protocol, (t) => {
          reply += t
          setMessages([...history, { role: 'assistant', content: reply }])
        })
      }
      if (!reply) reply = '（无返回内容）'
      setMessages([...history, { role: 'assistant', content: reply }])
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setMessages([...history, { role: 'assistant', content: `请求失败：${err instanceof Error ? err.message : String(err)}` }])
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">选择一个模型，开始对话</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
              }`}
            >
              {m.role === 'user' ? m.content : <MarkdownRenderer content={m.content} />}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-muted px-3 py-2 text-sm">…</div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>
      <div className="border-t p-3">
        <div className="flex gap-2">
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
            rows={2}
            className="resize-none"
          />
          {streaming ? (
            <Button variant="outline" size="icon" onClick={() => abortRef.current?.abort()}>
              <Loader2 className="h-4 w-4 animate-spin" />
            </Button>
          ) : (
            <Button size="icon" onClick={() => send()} disabled={!input.trim() || !provider || !model}>
              <SendHorizontal className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}