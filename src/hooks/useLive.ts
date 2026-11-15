import type { SupabaseClient } from '@supabase/supabase-js'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface Watch {
  table: string
  /** Postgres-changes filter, e.g. "session_id=eq.<uuid>" */
  filter?: string
}

/**
 * Live data: runs `fetcher`, then re-runs it whenever Supabase Realtime
 * reports a change on any watched table. Refetching on every event (rather
 * than patching local state) keeps the screen correct for inserts, updates
 * and deletes alike, and row-level security is applied by the fetch itself.
 * A slow poll covers a dropped socket.
 */
export function useLive<T>(
  db: SupabaseClient,
  fetcher: () => Promise<T>,
  watch: Watch[],
  deps: unknown[],
  options: { enabled?: boolean; pollMs?: number } = {},
) {
  const { enabled = true, pollMs = 20000 } = options
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const result = await fetchRef.current()
      if (alive.current) {
        setData(result)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  const watchKey = JSON.stringify(watch)

  useEffect(() => {
    alive.current = true
    if (!enabled) return
    setLoading(true)
    void refresh()
    const soon = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void refresh(), 120)
    }
    const channel = db.channel(`live-${Math.random().toString(36).slice(2)}`)
    for (const w of JSON.parse(watchKey) as Watch[]) {
      channel.on(
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: w.table, ...(w.filter ? { filter: w.filter } : {}) } as never,
        soon,
      )
    }
    channel.subscribe()
    const poll = setInterval(() => void refresh(), pollMs)
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
      clearInterval(poll)
      void db.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, enabled, watchKey, pollMs, refresh, ...deps])

  return { data, error, loading, refresh }
}

/** Re-renders every `ms` so timers on screen keep ticking. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
