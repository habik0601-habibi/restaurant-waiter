import { useState } from 'react'
import { useStaff } from '../../components/StaffShell'
import { Badge, Button, Notice, Sheet, Spinner } from '../../components/ui'
import { useLive, useNow } from '../../hooks/useLive'
import { friendly, minutesSince, rs } from '../../lib/format'
import { replan, staffDb } from '../../lib/supabase'
import { DEFAULT_STATE_LIMITS_MIN, STATE_LABEL, TABLE_STATES, isOverdue, nextStates, type TableState } from '../../lib/tableStateMachine'
import type { Bill, BillShare, Branch, CallReason, Order, SessionGuest, TableRow, TableSession, WaiterCall } from '../../lib/types'

interface FloorData {
  branch: Branch | null
  tables: TableRow[]
  sessions: TableSession[]
  guests: SessionGuest[]
  calls: WaiterCall[]
  orders: Order[]
  bills: Bill[]
  shares: BillShare[]
}

const STATE_STYLE: Record<TableState, string> = {
  free: 'bg-emerald-100 border-emerald-500 text-emerald-900',
  seated: 'bg-sky-100 border-sky-500 text-sky-900',
  ordered: 'bg-amber-100 border-amber-500 text-amber-900',
  eating: 'bg-violet-100 border-violet-500 text-violet-900',
  bill_requested: 'bg-rose-100 border-rose-500 text-rose-900',
  paid_dirty: 'bg-stone-200 border-stone-500 text-stone-800',
}

const REASON: Record<CallReason, string> = { help: '🙋 Assistance', water: '💧 Water', bill: '🧾 Bill', cutlery: '🍴 Cutlery', clean: '🧽 Clean table' }

/**
 * Live floor map. Every table is drawn in the colour of its state; a table
 * that has been in one state too long gets a warning ring, and a waiter call
 * makes it pulse red. All buttons call database functions, and the state
 * machine there decides what is legal: this screen only offers the moves that
 * tableStateMachine.ts lists for the current state.
 */
export default function Floor() {
  const staff = useStaff()
  const now = useNow(5000)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [party, setParty] = useState(2)
  const [limitsOpen, setLimitsOpen] = useState(false)

  const branchFilter = `branch_id=eq.${staff.branch_id}`
  const { data, loading, refresh } = useLive(
    staffDb,
    async (): Promise<FloorData> => {
      const b = staff.branch_id
      const [branch, tables, sessions, calls, orders, bills] = await Promise.all([
        staffDb.from('branches').select('*').eq('id', b).single(),
        staffDb.from('tables').select('*').eq('branch_id', b).order('label'),
        staffDb.from('table_sessions').select('*').eq('branch_id', b).in('status', ['pending', 'open']),
        staffDb.from('waiter_calls').select('*').eq('branch_id', b).eq('status', 'open').order('created_at'),
        staffDb.from('orders').select('*').eq('branch_id', b).eq('is_sample', false).eq('status', 'open'),
        staffDb.from('bills').select('*').eq('branch_id', b).eq('status', 'open'),
      ])
      if (tables.error) throw new Error(tables.error.message)
      const sessionIds = (sessions.data ?? []).map((s) => s.id)
      const [guests, shares] = sessionIds.length
        ? await Promise.all([
            staffDb.from('session_guests').select('*').in('session_id', sessionIds).order('joined_at'),
            staffDb.from('bill_shares').select('*').in('session_id', sessionIds).order('label'),
          ])
        : [{ data: [] }, { data: [] }]
      return {
        branch: branch.data as Branch | null,
        tables: (tables.data ?? []) as TableRow[],
        sessions: (sessions.data ?? []) as TableSession[],
        guests: (guests.data ?? []) as SessionGuest[],
        calls: (calls.data ?? []) as WaiterCall[],
        orders: (orders.data ?? []) as Order[],
        bills: (bills.data ?? []) as Bill[],
        shares: (shares.data ?? []) as BillShare[],
      }
    },
    [
      { table: 'tables', filter: branchFilter },
      { table: 'table_sessions', filter: branchFilter },
      { table: 'session_guests', filter: branchFilter },
      { table: 'waiter_calls', filter: branchFilter },
      { table: 'orders', filter: branchFilter },
      { table: 'bills', filter: branchFilter },
      { table: 'bill_shares', filter: branchFilter },
    ],
    [staff.branch_id],
    { pollMs: 10000 },
  )

  async function act(fn: () => PromiseLike<{ error: unknown }>, close = false) {
    setBusy(true)
    setError(null)
    const { error } = await fn()
    if (error) setError(friendly(error))
    else if (close) setSelected(null)
    await refresh()
    setBusy(false)
  }

  if (loading && !data) return <Spinner label="Loading the floor" />
  if (!data) return <Notice>Could not load the floor.</Notice>

  const limits = { ...DEFAULT_STATE_LIMITS_MIN, ...(data.branch?.settings?.state_limits_min ?? {}) }
  const sessionOf = (tableId: string) => data.sessions.find((s) => s.table_id === tableId)
  const label = (tableId: string) => data.tables.find((t) => t.id === tableId)?.label ?? '?'
  const pendingSessions = data.sessions.filter((s) => s.status === 'pending')
  const joinRequests = data.guests.filter((g) => g.status === 'pending' && data.sessions.find((s) => s.id === g.session_id)?.status === 'open')
  const overdue = data.tables.filter((t) => isOverdue(t.state, t.state_since, now, limits))
  const table = data.tables.find((t) => t.id === selected) ?? null
  const session = table ? sessionOf(table.id) : undefined
  const counts = TABLE_STATES.map((s) => [s, data.tables.filter((t) => t.state === s).length] as const)

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-bold">Floor</h1>
          <div className="flex flex-wrap items-center gap-1.5">
            {counts.map(([s, n]) => (
              <span key={s} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATE_STYLE[s]}`}>
                {STATE_LABEL[s]} {n}
              </span>
            ))}
            {(staff.role === 'owner' || staff.role === 'manager') && (
              <button onClick={() => setLimitsOpen(true)} className="rounded-full border border-stone-300 bg-white px-2 py-0.5 text-xs">
                ⏱ Time limits
              </button>
            )}
          </div>
        </div>
        {error && <div className="mb-2"><Notice>{error}</Notice></div>}

        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-stone-300 bg-white sm:aspect-[16/10]">
          <div className="absolute inset-x-0 top-0 h-2 bg-stone-200" title="Window wall" />
          <div className="absolute bottom-2 right-3 rounded bg-stone-100 px-2 py-1 text-[10px] uppercase tracking-wide text-stone-500">Kitchen →</div>
          <div className="absolute bottom-2 left-3 rounded bg-stone-100 px-2 py-1 text-[10px] uppercase tracking-wide text-stone-500">← Entrance</div>
          {data.tables.map((t) => {
            const calls = data.calls.filter((c) => c.table_id === t.id)
            const s = sessionOf(t.id)
            const late = isOverdue(t.state, t.state_since, now, limits)
            const size = t.capacity <= 2 ? 'w-[11%]' : t.capacity <= 4 ? 'w-[13%]' : 'w-[19%]'
            return (
              <button
                key={t.id}
                onClick={() => {
                  setSelected(t.id)
                  setParty(Math.min(2, t.capacity))
                  setError(null)
                }}
                style={{ left: `${t.pos_x}%`, top: `${t.pos_y}%` }}
                className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center border-2 text-center leading-tight ${size} ${
                  t.shape === 'round' ? 'aspect-square rounded-full' : t.shape === 'long' ? 'aspect-[16/9] rounded-2xl' : 'aspect-square rounded-2xl'
                } ${STATE_STYLE[t.state]} ${calls.length ? 'call-pulse !border-red-600' : ''} ${late ? 'ring-4 ring-orange-400' : ''}`}
              >
                <span className="text-sm font-bold sm:text-base">{t.label}</span>
                <span className="hidden text-[10px] sm:block">{STATE_LABEL[t.state]}</span>
                <span className="text-[10px] tabular-nums opacity-80">{t.state === 'free' ? `${t.capacity} seats` : `${minutesSince(t.state_since, now)} min`}</span>
                {calls.length > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-red-600 px-1.5 text-xs text-white">🔔</span>}
                {s?.status === 'pending' && <span className="absolute -left-1 -top-1 rounded-full bg-sky-600 px-1.5 text-[10px] font-bold text-white">SCAN</span>}
                {late && <span className="absolute -bottom-1 -right-1 rounded-full bg-orange-500 px-1.5 text-xs font-bold text-white">!</span>}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-stone-500">
          🔔 guest is calling · SCAN a phone asked to order · <span className="font-bold text-orange-600">!</span> in this state longer than its limit
        </p>
      </section>

      <aside className="space-y-3">
        <Panel title="Waiter calls" count={data.calls.length} empty="No one is calling.">
          {data.calls.map((c) => (
            <Row key={c.id} title={`Table ${label(c.table_id)} · ${REASON[c.reason]}`} sub={`${minutesSince(c.created_at, now)} min ago`} tone="red">
              <Button size="sm" disabled={busy} onClick={() => act(() => staffDb.rpc('staff_ack_call', { p_call: c.id }))}>
                On my way
              </Button>
            </Row>
          ))}
        </Panel>

        <Panel title="Scan requests" count={pendingSessions.length + joinRequests.length} empty="No one is waiting for approval.">
          {pendingSessions.map((s) => {
            const who = data.guests.filter((g) => g.session_id === s.id).map((g) => g.display_name).join(', ')
            return (
              <Row key={s.id} title={`Table ${label(s.table_id)} wants to order`} sub={`${who || 'Guest'} · party of ${s.party_size} · look at the table before you accept`} tone="blue">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => staffDb.rpc('staff_decide_session', { p_session: s.id, p_approve: false }))}>
                  Deny
                </Button>
                <Button size="sm" disabled={busy} onClick={() => act(() => staffDb.rpc('staff_decide_session', { p_session: s.id, p_approve: true }))}>
                  Accept
                </Button>
              </Row>
            )
          })}
          {joinRequests.map((g) => {
            const s = data.sessions.find((x) => x.id === g.session_id)
            return (
              <Row key={g.id} title={`${g.display_name} wants to join table ${s ? label(s.table_id) : '?'}`} sub="Guests at the table can also let them in" tone="blue">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => staffDb.rpc('decide_guest', { p_guest: g.id, p_approve: false }))}>
                  Deny
                </Button>
                <Button size="sm" disabled={busy} onClick={() => act(() => staffDb.rpc('decide_guest', { p_guest: g.id, p_approve: true }))}>
                  Accept
                </Button>
              </Row>
            )
          })}
        </Panel>

        <Panel title="Needs attention" count={overdue.length} empty="No table is over its time limit.">
          {overdue.map((t) => (
            <Row key={t.id} title={`Table ${t.label} · ${STATE_LABEL[t.state]}`} sub={`${minutesSince(t.state_since, now)} min, limit ${limits[t.state]} min`} tone="amber">
              <Button size="sm" variant="secondary" onClick={() => setSelected(t.id)}>
                Open
              </Button>
            </Row>
          ))}
        </Panel>
      </aside>

      <Sheet open={!!table} onClose={() => setSelected(null)} title={table ? `Table ${table.label}` : ''}>
        {table && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2.5 py-1 text-sm font-semibold ${STATE_STYLE[table.state]}`}>{STATE_LABEL[table.state]}</span>
              <span className="text-sm text-stone-500">
                for {minutesSince(table.state_since, now)} min · seats {table.capacity}
              </span>
            </div>
            {error && <Notice>{error}</Notice>}

            {session && (
              <div className="rounded-xl bg-stone-50 p-3 text-sm">
                <p>
                  <b>Session:</b> {session.status}, party of {session.party_size}
                </p>
                <p className="text-stone-600">
                  Guests: {data.guests.filter((g) => g.session_id === session.id).map((g) => `${g.display_name}${g.status === 'pending' ? ' (waiting)' : ''}`).join(', ') || 'none on phones yet'}
                </p>
                <p className="text-stone-600">Open orders: {data.orders.filter((o) => o.session_id === session.id).map((o) => `#${o.order_no}`).join(', ') || 'none'}</p>
              </div>
            )}

            {session?.status === 'pending' && (
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => act(() => staffDb.rpc('staff_decide_session', { p_session: session.id, p_approve: false }), true)}>
                  Deny scan
                </Button>
                <Button className="flex-1" disabled={busy} onClick={() => act(() => staffDb.rpc('staff_decide_session', { p_session: session.id, p_approve: true }), true)}>
                  Accept and seat
                </Button>
              </div>
            )}

            {table.state === 'free' && session?.status !== 'pending' && (
              <div className="flex items-center gap-3">
                <span className="text-sm">Guests</span>
                <button className="h-10 w-10 rounded-full border border-stone-300 text-lg" onClick={() => setParty((p) => Math.max(1, p - 1))} aria-label="Fewer guests">−</button>
                <span className="w-5 text-center font-bold">{party}</span>
                <button className="h-10 w-10 rounded-full border border-stone-300 text-lg" onClick={() => setParty((p) => Math.min(30, p + 1))} aria-label="More guests">+</button>
                <Button className="flex-1" disabled={busy} onClick={() => act(() => staffDb.rpc('staff_seat_table', { p_table: table.id, p_party_size: party }), true)}>
                  Seat guests
                </Button>
              </div>
            )}

            {table.state === 'seated' && (
              <Button variant="secondary" className="w-full" disabled={busy} onClick={() => act(() => staffDb.rpc('staff_close_table', { p_table: table.id }), true)}>
                Guests left without ordering
              </Button>
            )}

            {table.state === 'eating' && session && (
              <Button className="w-full" disabled={busy} onClick={() => act(() => staffDb.rpc('request_bill', { p_session: session.id }))}>
                Prepare the bill for this table
              </Button>
            )}

            {table.state === 'bill_requested' && session && (
              <div className="space-y-2">
                {data.bills.filter((b) => b.session_id === session.id).map((b) => (
                  <p key={b.id} className="text-sm">
                    Bill total <b>{rs(b.total)}</b> ({b.split_mode === 'whole' ? 'one bill' : b.split_mode === 'equal' ? 'split equally' : 'split by who ordered'})
                  </p>
                ))}
                {data.shares.filter((s) => s.session_id === session.id).map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-xl border border-stone-200 p-2 text-sm">
                    <span>
                      {s.label} · {rs(s.amount + s.tip)}
                    </span>
                    {s.status === 'paid' ? (
                      <Badge tone="green">Paid</Badge>
                    ) : (
                      <Button size="sm" disabled={busy} onClick={() => act(() => staffDb.rpc('pay_share', { p_share: s.id, p_method: 'cash' }))}>
                        Took cash (simulated)
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {(table.state === 'ordered' || table.state === 'eating') && (
              <Button
                variant="danger"
                className="w-full"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Close table ${table.label}? Dishes still in the kitchen are cancelled and the session ends.`)) {
                    void act(async () => {
                      const r = await staffDb.rpc('staff_close_table', { p_table: table.id })
                      void replan(staffDb, staff.branch_id)
                      return r
                    }, true)
                  }
                }}
              >
                Close table (settled at the counter)
              </Button>
            )}

            {table.state === 'paid_dirty' && (
              <Button className="w-full" disabled={busy} onClick={() => act(() => staffDb.rpc('staff_clear_table', { p_table: table.id }), true)}>
                Table cleared
              </Button>
            )}

            <p className="text-xs text-stone-500">
              From “{STATE_LABEL[table.state]}” this table can move to: {nextStates(table.state).map((s) => STATE_LABEL[s]).join(', ') || 'nothing'}.
            </p>
          </div>
        )}
      </Sheet>

      {limitsOpen && data.branch && (
        <LimitsSheet
          branch={data.branch}
          onClose={() => setLimitsOpen(false)}
          onSaved={() => {
            setLimitsOpen(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

function Panel({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2">
        <h2 className="font-bold">{title}</h2>
        <Badge tone={count ? 'red' : 'stone'}>{count}</Badge>
      </div>
      <div className="space-y-2 p-2">{count === 0 ? <p className="p-2 text-sm text-stone-400">{empty}</p> : children}</div>
    </div>
  )
}

function Row({ title, sub, tone, children }: { title: string; sub: string; tone: 'red' | 'blue' | 'amber'; children: React.ReactNode }) {
  const tones = { red: 'border-red-300 bg-red-50', blue: 'border-sky-300 bg-sky-50', amber: 'border-orange-300 bg-orange-50' }
  return (
    <div className={`rounded-xl border p-2.5 ${tones[tone]}`}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs text-stone-600">{sub}</p>
      <div className="mt-2 flex justify-end gap-2">{children}</div>
    </div>
  )
}

/** Owner/manager: how long a table may sit in each state before it is flagged. */
function LimitsSheet({ branch, onClose, onSaved }: { branch: Branch; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, number>>({ ...DEFAULT_STATE_LIMITS_MIN, ...(branch.settings?.state_limits_min ?? {}) })
  const [error, setError] = useState<string | null>(null)
  const states: TableState[] = ['seated', 'ordered', 'eating', 'bill_requested', 'paid_dirty']

  async function save() {
    const settings = { ...branch.settings, state_limits_min: values }
    const { data, error } = await staffDb.from('branches').update({ settings }).eq('id', branch.id).select()
    if (error || !data?.length) setError(error ? friendly(error) : 'You are not allowed to change this.')
    else onSaved()
  }

  return (
    <Sheet open onClose={onClose} title="Time limits per state">
      <p className="mb-3 text-sm text-stone-600">A table that stays in a state longer than this is flagged on the map. Minutes.</p>
      <div className="space-y-2">
        {states.map((s) => (
          <label key={s} className="flex items-center justify-between gap-3 text-sm">
            {STATE_LABEL[s]}
            <input
              type="number"
              min={1}
              max={600}
              value={values[s] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [s]: Math.max(1, Number(e.target.value) || 1) }))}
              className="w-24 rounded-lg border border-stone-300 px-2 py-1.5 text-right"
            />
          </label>
        ))}
      </div>
      {error && <div className="mt-3"><Notice>{error}</Notice></div>}
      <Button className="mt-4 w-full" onClick={save}>
        Save limits
      </Button>
    </Sheet>
  )
}
