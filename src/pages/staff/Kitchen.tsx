import { useEffect, useState } from 'react'
import { useStaff } from '../../components/StaffShell'
import { Badge, Button, Notice, Spinner } from '../../components/ui'
import { useLive, useNow } from '../../hooks/useLive'
import { clock, friendly, minutesSince } from '../../lib/format'
import { replan, staffDb } from '../../lib/supabase'
import type { OrderItem, Station } from '../../lib/types'

type KitchenItem = OrderItem & { orders: { order_no: number; placed_at: string; table_id: string | null; estimated_ready_at: string | null } }

interface KitchenData {
  stations: Station[]
  items: KitchenItem[]
  tables: Record<string, string>
}

/**
 * Kitchen display. One column per station plus a pass ("ready to serve").
 * Queued dishes are ordered by the scheduler's planned start time, and each
 * shows either a countdown ("start in 6 min") or START NOW. The cook taps
 * Start and Ready; every tap triggers a re-plan, and so does a 30 second
 * timer, which is how a dish that runs late pushes the plan back.
 */
export default function Kitchen() {
  const staff = useStaff()
  const now = useNow(1000)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const { data, loading, refresh } = useLive(
    staffDb,
    async (): Promise<KitchenData> => {
      const [stations, items, tables] = await Promise.all([
        staffDb.from('stations').select('*').eq('branch_id', staff.branch_id).order('sort'),
        staffDb
          .from('order_items')
          .select('*, orders!inner(order_no, placed_at, table_id, estimated_ready_at)')
          .eq('branch_id', staff.branch_id)
          .eq('is_sample', false)
          .in('status', ['queued', 'cooking', 'ready'])
          .order('created_at'),
        staffDb.from('tables').select('id, label').eq('branch_id', staff.branch_id),
      ])
      if (items.error) throw new Error(items.error.message)
      return {
        stations: (stations.data ?? []) as Station[],
        items: (items.data ?? []) as unknown as KitchenItem[],
        tables: Object.fromEntries((tables.data ?? []).map((t) => [t.id, t.label])),
      }
    },
    [{ table: 'order_items', filter: `branch_id=eq.${staff.branch_id}` }, { table: 'orders', filter: `branch_id=eq.${staff.branch_id}` }],
    [staff.branch_id],
    { pollMs: 15000 },
  )

  // keep the plan fresh: catches dishes that run past their expected time
  useEffect(() => {
    void replan(staffDb, staff.branch_id)
    const t = setInterval(() => void replan(staffDb, staff.branch_id), 30000)
    return () => clearInterval(t)
  }, [staff.branch_id])

  async function act(key: string, fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(key)
    setError(null)
    const { error } = await fn()
    if (error) setError(friendly(error))
    await refresh()
    setBusy(null)
    void replan(staffDb, staff.branch_id)
  }
  const setStatus = (item: KitchenItem, status: string) =>
    act(item.id, () => staffDb.rpc('kitchen_set_item_status', { p_item: item.id, p_status: status }))

  if (loading && !data) return <Spinner label="Loading the kitchen" />
  if (!data) return <Notice>Could not load the kitchen.</Notice>

  const tableOf = (i: KitchenItem) => (i.orders.table_id ? data.tables[i.orders.table_id] ?? '?' : '?')
  const ready = data.items.filter((i) => i.status === 'ready')
  const readyOrders = [...new Set(ready.map((i) => i.order_id))]
  const working = data.items.filter((i) => i.status !== 'ready')

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Kitchen</h1>
        <p className="text-sm text-stone-500">
          {working.filter((i) => i.status === 'cooking').length} cooking · {working.filter((i) => i.status === 'queued').length} queued · {ready.length} ready
        </p>
      </div>
      {error && <div className="mb-3"><Notice>{error}</Notice></div>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {data.stations.map((st) => {
          const mine = working.filter((i) => i.station_id === st.id)
          const cooking = mine.filter((i) => i.status === 'cooking').sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''))
          const queued = mine
            .filter((i) => i.status === 'queued')
            .sort((a, b) => (a.planned_start_at ?? '9').localeCompare(b.planned_start_at ?? '9') || a.created_at.localeCompare(b.created_at))
          const full = cooking.length >= st.capacity
          return (
            <section key={st.id} className="rounded-2xl border border-stone-200/80 bg-paper shadow-card">
              <header className="flex items-center justify-between border-b border-stone-200 px-3 py-2.5">
                <h2 className="font-sans text-sm font-bold uppercase tracking-wide text-stone-700">{st.name}</h2>
                <Badge tone={cooking.length > st.capacity ? 'red' : full ? 'amber' : 'green'}>
                  {cooking.length} / {st.capacity} in use
                </Badge>
              </header>
              <div className="space-y-2 p-2">
                {mine.length === 0 && <p className="p-4 text-center text-sm text-stone-400">Nothing waiting</p>}

                {cooking.map((i) => {
                  const mins = minutesSince(i.started_at, now)
                  const late = mins >= i.prep_minutes
                  return (
                    <article key={i.id} className={`rounded-xl border-2 p-2.5 ${late ? 'border-red-400 bg-red-50' : 'border-amber-300 bg-amber-50'}`}>
                      <ItemHead item={i} table={tableOf(i)} now={now} />
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className={`text-sm font-semibold tabular-nums ${late ? 'text-red-700' : 'text-amber-800'}`}>
                          Cooking {clock(i.started_at, now)} / {i.prep_minutes}:00{late ? ' · running late' : ''}
                        </span>
                        <span className="flex gap-1">
                          <button className="rounded-lg px-2 text-xs text-stone-500 hover:bg-white" disabled={busy === i.id} onClick={() => setStatus(i, 'queued')}>
                            Undo
                          </button>
                          <Button size="sm" disabled={busy === i.id} onClick={() => setStatus(i, 'ready')}>
                            Ready
                          </Button>
                        </span>
                      </div>
                    </article>
                  )
                })}

                {queued.map((i) => {
                  // within 20 seconds counts as "now" (covers clock differences between tablet and server)
                  const ms = i.planned_start_at ? new Date(i.planned_start_at).getTime() - now : null
                  const startIn = ms === null ? null : ms <= 20000 ? Math.min(0, Math.ceil(ms / 60000)) : Math.ceil(ms / 60000)
                  const due = startIn !== null && startIn <= 0
                  return (
                    <article key={i.id} className={`rounded-xl border p-2.5 ${due ? 'border-emerald-500 bg-emerald-50' : 'border-stone-200 bg-stone-50'}`}>
                      <ItemHead item={i} table={tableOf(i)} now={now} />
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className={`text-sm font-semibold ${due ? 'text-emerald-800' : 'text-stone-600'}`}>
                          {startIn === null ? 'Planning…' : due ? (startIn < 0 ? `START NOW · ${-startIn} min overdue` : 'START NOW') : `Start in ${startIn} min`}
                        </span>
                        <Button size="sm" variant={due ? 'primary' : 'secondary'} disabled={busy === i.id} onClick={() => setStatus(i, 'cooking')}>
                          Start
                        </Button>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          )
        })}

        <section className="rounded-2xl border border-stone-200/80 bg-paper shadow-card md:col-span-2 xl:col-span-1">
          <header className="flex items-center justify-between border-b border-stone-200 px-3 py-2.5">
            <h2 className="font-sans text-sm font-bold uppercase tracking-wide text-stone-700">Pass · ready to serve</h2>
            <Badge tone="blue">{ready.length}</Badge>
          </header>
          <div className="space-y-2 p-2">
            {readyOrders.length === 0 && <p className="p-4 text-center text-sm text-stone-400">Nothing on the pass</p>}
            {readyOrders.map((orderId) => {
              const items = ready.filter((i) => i.order_id === orderId)
              const remaining = working.filter((i) => i.order_id === orderId).length
              const first = items[0]
              return (
                <article key={orderId} className={`rounded-xl border-2 p-2.5 ${remaining === 0 ? 'border-sky-400 bg-sky-50' : 'border-stone-200 bg-stone-50'}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold">
                      Table {tableOf(first)} <span className="text-sm font-normal text-stone-500">#{first.orders.order_no}</span>
                    </span>
                    <span className="text-xs tabular-nums text-stone-500">{clock(first.orders.placed_at, now)}</span>
                  </div>
                  <ul className="mt-1 text-sm">
                    {items.map((i) => (
                      <li key={i.id}>
                        {i.name}
                        {i.size_name ? ` · ${i.size_name}` : ''}
                        <span className="text-xs text-stone-400"> · waiting {minutesSince(i.ready_at, now)} min</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-stone-500">{remaining === 0 ? 'Whole order ready' : `${remaining} more still cooking`}</span>
                    <Button size="sm" variant={remaining === 0 ? 'primary' : 'secondary'} disabled={busy === orderId} onClick={() => act(orderId, () => staffDb.rpc('kitchen_serve_order', { p_order: orderId }))}>
                      Served
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      </div>
      <p className="mt-3 text-xs text-stone-500">
        Start times come from the kitchen scheduler: short dishes are held back so a table&apos;s food finishes together. The cook can always start a dish early.
      </p>
    </div>
  )
}

function ItemHead({ item, table, now }: { item: KitchenItem; table: string; now: number }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold">
          {item.name}
          {item.size_name ? <span className="font-normal text-stone-600"> · {item.size_name}</span> : null}
        </span>
        <span className="shrink-0 rounded-md bg-ink px-1.5 py-0.5 text-xs font-bold text-white">{table}</span>
      </div>
      <div className="flex items-center justify-between text-xs text-stone-500">
        <span>Order #{item.orders.order_no}</span>
        <span className="tabular-nums">ordered {clock(item.orders.placed_at, now)} ago</span>
      </div>
      {item.notes && <p className="mt-1 rounded-md bg-yellow-100 px-2 py-1 text-xs font-semibold text-yellow-900">Note: {item.notes}</p>}
    </>
  )
}
