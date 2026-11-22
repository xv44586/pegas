import Markdown, { type Components } from 'react-markdown'
import { useMemo } from 'react'
import remarkGfm from 'remark-gfm'

import {
  LinkPreviewAnchor,
  LinkPreviewLoaderContext,
  type LinkPreviewLoader,
} from './LinkPreviewCard'

export function MarkdownMessage({
  content,
  linkPreviewLoader,
}: {
  content: string
  linkPreviewLoader?: LinkPreviewLoader
}) {
  const components = useMemo<Components>(
    () => ({
      pre({ children }) {
        return <pre tabIndex={0}>{children}</pre>
      },
      a({ children, href }) {
        if (!href) return <>{children}</>
        return <LinkPreviewAnchor href={href}>{children}</LinkPreviewAnchor>
      },
    }),
    [],
  )
  return (
    <div className="message-markdown">
      <LinkPreviewLoaderContext.Provider value={linkPreviewLoader}>
        <Markdown components={components} remarkPlugins={[remarkGfm]} skipHtml>
          {content}
        </Markdown>
      </LinkPreviewLoaderContext.Provider>
    </div>
  )
}
