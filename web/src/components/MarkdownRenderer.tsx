import ReactMarkdown from 'react-markdown'

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  )
}