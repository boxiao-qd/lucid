// MarkdownRenderer — renders markdown content with stone-palette styling.
// Used for assistant messages. Streaming delta stays as plain text (incomplete
// markdown would look broken mid-stream).

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function MarkdownRenderer({
  content,
  className
}: {
  content: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={className ?? 'text-sm leading-relaxed text-stone-800'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-4 text-lg font-bold text-stone-900">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-base font-bold text-stone-900">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-3 text-sm font-bold text-stone-900">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-2 text-sm font-semibold text-stone-800">{children}</h4>
          ),
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-2 ml-5 list-disc space-y-0.5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 ml-5 list-decimal space-y-0.5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          code: ({ className, children }) => {
            const isBlock = className?.includes('language-')
            if (isBlock) {
              return <code className="block">{children}</code>
            }
            return (
              <code className="rounded bg-stone-200 px-1 py-0.5 font-mono text-xs text-stone-700">
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded-lg border border-stone-200 bg-white p-3 last:mb-0">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-stone-300 pl-3 text-stone-600 last:mb-0">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-600 underline underline-offset-2 hover:text-stone-800"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <table className="mb-2 w-full border-collapse text-xs last:mb-0">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border border-stone-300 bg-stone-100 px-2 py-1 text-left font-semibold text-stone-700">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-stone-300 px-2 py-1 text-stone-600">{children}</td>
          ),
          hr: () => <hr className="my-3 border-stone-200" />,
          strong: ({ children }) => (
            <strong className="font-semibold text-stone-900">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export default MarkdownRenderer
