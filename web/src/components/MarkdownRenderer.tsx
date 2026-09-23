import ReactMarkdown from 'react-markdown'

function safeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  return ''
}

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="text-sm leading-6">
      <ReactMarkdown
        components={{
          a: ({ href, children, ...props }) => (
            <a href={safeUrl(href ?? '')} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2" {...props}>
              {children}
            </a>
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? '')
            if (isBlock) {
              return (
                <code className={`${className ?? ''} block font-mono text-xs`} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props}>
                {children}
              </code>
            )
          },
          pre: ({ children, ...props }) => (
            <pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs" {...props}>
              {children}
            </pre>
          ),
          ul: ({ children, ...props }) => (
            <ul className="my-2 list-disc space-y-1 pl-5" {...props}>{children}</ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5" {...props}>{children}</ol>
          ),
          li: ({ children, ...props }) => (
            <li className="leading-6" {...props}>{children}</li>
          ),
          p: ({ children, ...props }) => (
            <p className="my-1.5 first:mt-0 last:mb-0" {...props}>{children}</p>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
