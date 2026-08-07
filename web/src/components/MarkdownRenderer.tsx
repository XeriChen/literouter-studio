import ReactMarkdown from 'react-markdown'

function safeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  return ''
}

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown
        components={{
          a: ({ href, children, ...props }) => (
            <a href={safeUrl(href ?? '')} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}