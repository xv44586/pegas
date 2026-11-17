import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  pre({ children }) {
    return <pre tabIndex={0}>{children}</pre>
  },
}

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="message-markdown">
      <Markdown components={components} remarkPlugins={[remarkGfm]} skipHtml>
        {content}
      </Markdown>
    </div>
  )
}
