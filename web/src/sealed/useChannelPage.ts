import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChannelSearchFilters,
  ChannelSearchResult,
  WorkChannel,
} from '../types'

export interface ChannelListClient {
  searchChannels: (
    query: string,
    filters?: ChannelSearchFilters,
    cursor?: string,
  ) => Promise<ChannelSearchResult>
}

/** Each filter generation owns its responses. A failed continuation retains its cursor. */
export function useChannelPage(
  client: ChannelListClient | undefined,
  query: string,
  filters: ChannelSearchFilters,
  refreshKey: string,
) {
  const key = JSON.stringify(filters)
  const [page, setPage] = useState<ChannelSearchResult>({
    channels: [],
    matches: [],
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(client))
  const generation = useRef(0)
  const busy = useRef(false)
  const fetchPage = useCallback(
    async (version: number, cursor?: string) => {
      if (!client) return
      busy.current = true
      setLoading(true)
      setError('')
      try {
        const result = await client.searchChannels(
          query,
          JSON.parse(key) as ChannelSearchFilters,
          cursor,
        )
        if (version !== generation.current) return
        setPage(previous => ({
          ...result,
          channels: cursor
            ? [
                ...new Map(
                  [...previous.channels, ...result.channels].map(channel => [
                    channel.id,
                    channel,
                  ]),
                ).values(),
              ]
            : result.channels,
        }))
      } catch {
        if (version === generation.current)
          setError('事情列表加载失败，请重试。')
      } finally {
        if (version === generation.current) {
          busy.current = false
          setLoading(false)
        }
      }
    },
    [client, query, key],
  )
  useEffect(() => {
    const version = ++generation.current
    setLoading(Boolean(client))
    setPage({ channels: [], matches: [] })
    const timer = window.setTimeout(
      () => void fetchPage(version),
      query ? 200 : 0,
    )
    return () => {
      window.clearTimeout(timer)
      generation.current++
    }
  }, [fetchPage, refreshKey, query, client])
  return {
    ...page,
    error,
    loading,
    loadMore: () => {
      if (!busy.current) void fetchPage(generation.current, page.nextCursor)
    },
    reload: () => {
      void fetchPage(++generation.current)
    },
  }
}

export function channelListKey(channels: WorkChannel[]): string {
  return channels
    .map(
      channel =>
        `${channel.id}:${String(channel.organization?.revision ?? 0)}:${channel.latestActivityAt}:${channel.status}`,
    )
    .sort()
    .join('|')
}
