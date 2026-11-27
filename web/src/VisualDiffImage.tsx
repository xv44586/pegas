import { Button } from '@bui/components/atoms/Button'
import { useEffect, useState } from 'react'
import { webAccessHeaders } from './api'

/** Only the dedicated, authenticated, server-rendered SVG endpoint. */
export function isVisualDiffUrl(value: string): boolean {
  return /^\/v1\/runs\/[a-zA-Z0-9-]+\/visual-diff\?userId=[^&#\s]+$/.test(value)
}

export function VisualDiffImage({ src, alt }: { src: string; alt: string }) {
  const [content, setContent] = useState<{ source: string; url: string }>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    let objectUrl: string | undefined
    setError('')
    setContent(undefined)
    fetch(src, {
      headers: webAccessHeaders(sessionStorage.getItem('pegas-token') ?? ''),
      signal: abort.signal,
    })
      .then(async response => {
        if (
          !response.ok ||
          response.headers.get('content-type')?.split(';')[0] !==
            'image/svg+xml'
        )
          throw new Error('流程图暂时无法读取。')
        const blob = await response.blob()
        if (abort.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setContent({ source: src, url: objectUrl })
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError('流程图暂时无法读取，文字汇报不受影响。')
      })
    return () => {
      abort.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src, attempt])
  const current = content?.source === src ? content : undefined
  if (error)
    return (
      <span role="status">
        {error}{' '}
        <Button
          type="button"
          size="sm"
          onClick={() => setAttempt(value => value + 1)}
        >
          重试流程图
        </Button>
      </span>
    )
  if (!current) return <span role="status">正在读取流程图…</span>
  return (
    <span className="block my-3">
      <img alt={alt} className="block h-auto w-full" src={current.url} />
      <a href={current.url} download="pegas-visual-diff.svg">
        下载动态 SVG
      </a>
      <span className="ml-3 text-[12px] text-ink-2">
        源码流程说明，非运行录像
      </span>
    </span>
  )
}
