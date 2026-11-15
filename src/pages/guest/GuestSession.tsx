import { useMemo, useState } from 'react'
import { Badge, Button, Notice, Sheet, Simulated } from '../../components/ui'
import { useLive, useNow } from '../../hooks/useLive'
import { friendly, minutesUntil, rs } from '../../lib/format'
import { guestDb, replan } from '../../lib/supabase'
import type { Bill, BillShare, CallReason, CartItem, MenuItem, Order, OrderItem, SessionGuest, TableView, WaiterCall } from '../../lib/types'
import { MenuBrowser, priceOf, type MenuData } from './menu'

type Tab = 'menu' | 'cart' | 'orders' | 'bill'

interface SessionData {
  guests: SessionGuest[]
  cart: CartItem[]
  orders: Order[]
  items: OrderItem[]
  calls: WaiterCall[]
  bill: Bill | null
  shares: BillShare[]
}

const EMPTY: SessionData = { guests: [], cart: [], orders: [], items: [], calls: [], bill: null, shares: [] }

const CALL_REASONS: { reason: CallReason; label: string; icon: string }[] = [
  { reason: 'help', label: 'Assistance', icon: '🙋' },
  { reason: 'water', label: 'Water', icon: '💧' },
  { reason: 'cutlery', label: 'Cutlery', icon: '🍴' },
  { reason: 'clean', label: 'Clean table', icon: '🧽' },
  { reason: 'bill', label: 'Bring the bill', icon: '🧾' },
]

export const PAY_METHODS: { id: string; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'card', label: 'Card' },
  { id: 'bank_transfer', label: 'Bank transfer' },
  { id: 'jazzcash', label: 'JazzCash' },
  { id: 'easypaisa', label: 'Easypaisa' },
  { id: 'raast', label: 'Raast QR' },
]

const ITEM_STATUS: Record<OrderItem['status'], { label: string; tone: 'stone' | 'amber' | 'green' | 'blue' | 'red' }> = {
  queued: { label: 'In the queue', tone: 'stone' },
  cooking: { label: 'Cooking', tone: 'amber' },
  ready: { label: 'Ready', tone: 'blue' },
  served: { label: 'Served', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'red' },
}

/** The ordering app a guest sees once they are an approved member of an open session. */
export default function GuestSession({ view, sessionId, guestId, menu }: { view: TableView; sessionId: string; guestId: string; menu: MenuData }) {
  const [tab, setTab] = useState<Tab>('menu')
  const [picked, setPicked] = useState<MenuItem | null>(null)
  const [callOpen, setCallOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const now = useNow(15000)

  const filter = `session_id=eq.${sessionId}`
  const { data = EMPTY, refresh } = useLive(
    guestDb,
    async (): Promise<SessionData> => {
      const [guests, cart, orders, items, calls, bill, shares] = await Promise.all([
        guestDb.from('session_guests').select('*').eq('session_id', sessionId).order('joined_at'),
        guestDb.from('cart_items').select('*').eq('session_id', sessionId).order('created_at'),
        guestDb.from('orders').select('*').eq('session_id', sessionId).order('placed_at'),
        guestDb.from('order_items').select('*').eq('session_id', sessionId).order('created_at'),
        guestDb.from('waiter_calls').select('*').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10),
        guestDb.from('bills').select('*').eq('session_id', sessionId).maybeSingle(),
        guestDb.from('bill_shares').select('*').eq('session_id', sessionId).order('label'),
      ])
      return {
        guests: (guests.data ?? []) as SessionGuest[],
        cart: (cart.data ?? []) as CartItem[],
        orders: (orders.data ?? []) as Order[],
        items: (items.data ?? []) as OrderItem[],
        calls: (calls.data ?? []) as WaiterCall[],
        bill: (bill.data ?? null) as Bill | null,
        shares: (shares.data ?? []) as BillShare[],
      }
    },
    [
      { table: 'session_guests', filter },
      { table: 'cart_items', filter },
      { table: 'orders', filter },
      { table: 'order_items', filter },
      { table: 'waiter_calls', filter },
      { table: 'bills', filter },
      { table: 'bill_shares', filter },
    ],
    [sessionId],
    { pollMs: 10000 },
  )

  const guestName = (id: string | null) => {
    if (id === guestId) return 'You'
    return data.guests.find((g) => g.id === id)?.display_name ?? 'Guest'
  }
  const itemById = useMemo(() => new Map(menu.items.map((i) => [i.id, i])), [menu.items])
  const sizeById = useMemo(() => new Map(menu.sizes.map((s) => [s.id, s])), [menu.sizes])

  const cartLines = data.cart.map((c) => {
    const item = itemById.get(c.menu_item_id)
    const size = c.size_id ? sizeById.get(c.size_id) : null
    const price = item ? priceOf(menu, item, size).price : 0
    return { ...c, item, size, price, total: price * c.qty }
  })
  const cartCount = data.cart.reduce((n, c) => n + c.qty, 0)
  const cartTotal = cartLines.reduce((n, c) => n + c.total, 0)
  const pendingGuests = data.guests.filter((g) => g.status === 'pending')
  const liveItems = data.items.filter((i) => i.status !== 'cancelled')
  const allServed = liveItems.length > 0 && liveItems.every((i) => i.status === 'served')
  const openOrders = data.orders.filter((o) => o.status === 'open')
  const billing = !!data.bill

  async function run<T>(fn: () => PromiseLike<{ error: unknown; data?: T }>): Promise<boolean> {
    setBusy(true)
    setError(null)
    const { error } = await fn()
    if (error) setError(friendly(error))
    await refresh()
    setBusy(false)
    return !error
  }

  async function placeOrder() {
    const ok = await run(() => guestDb.rpc('place_order', { p_session: sessionId }))
    if (ok) {
      setTab('orders')
      await replan(guestDb, view.branch_id)
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-cream">
      <header className="bg-brand-900 px-4 pb-4 pt-5 text-white">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-saffron-400">Table {view.label}</p>
            <h1 className="text-xl font-bold">{view.restaurant_name}</h1>
          </div>
          <p className="text-right text-xs text-brand-100">
            {data.guests.filter((g) => g.status === 'approved').map((g) => (g.id === guestId ? 'You' : g.display_name)).join(', ')}
          </p>
        </div>
        {openOrders.length > 0 && <WaitBanner orders={openOrders} now={now} />}
      </header>

      <main className="flex-1 px-4 pb-40 pt-3">
        {error && <div className="mb-3"><Notice>{error}</Notice></div>}

        {pendingGuests.map((g) => (
          <div key={g.id} className="mb-3 flex items-center justify-between gap-2 rounded-2xl border border-saffron-400 bg-saffron-100 p-3">
            <span className="text-sm"><b>{g.display_name}</b> wants to join your table</span>
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => guestDb.rpc('decide_guest', { p_guest: g.id, p_approve: false }))}>
                No
              </Button>
              <Button size="sm" disabled={busy} onClick={() => run(() => guestDb.rpc('decide_guest', { p_guest: g.id, p_approve: true }))}>
                Let in
              </Button>
            </span>
          </div>
        ))}

        {tab === 'menu' && (
          <>
            {billing && <div className="mb-2"><Notice tone="amber">The bill has been requested, so ordering is closed for this visit.</Notice></div>}
            <MenuBrowser menu={menu} onPick={billing ? undefined : setPicked} />
          </>
        )}

        {tab === 'cart' && (
          <section>
            <h2 className="mb-1 text-lg font-bold">Shared cart</h2>
            <p className="mb-3 text-sm text-stone-600">Everyone at the table sees this cart update live.</p>
            {cartLines.length === 0 && <p className="rounded-2xl bg-white p-6 text-center text-sm text-stone-500">Nothing in the cart yet.</p>}
            <div className="space-y-2">
              {cartLines.map((c) => (
                <div key={c.id} className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-stone-100">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold">{c.item?.name ?? 'Dish'}</div>
                      <div className="text-xs text-stone-500">
                        {c.size ? `${c.size.name} · ` : ''}added by {guestName(c.guest_id)}
                      </div>
                      {c.notes && <div className="mt-1 text-xs italic text-stone-600">“{c.notes}”</div>}
                    </div>
                    <div className="text-right font-semibold">{rs(c.total)}</div>
                  </div>
                  {c.guest_id === guestId ? (
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        className="h-10 w-10 rounded-full border border-stone-300 text-lg"
                        aria-label="One fewer"
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            c.qty > 1
                              ? guestDb.from('cart_items').update({ qty: c.qty - 1 }).eq('id', c.id)
                              : guestDb.from('cart_items').delete().eq('id', c.id),
                          )
                        }
                      >
                        −
                      </button>
                      <span className="w-5 text-center font-bold">{c.qty}</span>
                      <button
                        className="h-10 w-10 rounded-full border border-stone-300 text-lg"
                        aria-label="One more"
                        disabled={busy || c.qty >= 20}
                        onClick={() => run(() => guestDb.from('cart_items').update({ qty: c.qty + 1 }).eq('id', c.id))}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-stone-500">Quantity {c.qty}</div>
                  )}
                </div>
              ))}
            </div>
            {cartLines.length > 0 && (
              <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex justify-between text-base font-bold">
                  <span>Cart total</span>
                  <span>{rs(cartTotal)}</span>
                </div>
                <Button size="lg" className="mt-3 w-full" disabled={busy} onClick={placeOrder}>
                  {busy ? 'Sending to the kitchen…' : `Place order · ${rs(cartTotal)}`}
                </Button>
                <p className="mt-2 text-center text-xs text-stone-500">Prices are confirmed by the restaurant when the order is placed.</p>
              </div>
            )}
          </section>
        )}

        {tab === 'orders' && (
          <section>
            <h2 className="mb-3 text-lg font-bold">Your orders</h2>
            {data.orders.length === 0 && <p className="rounded-2xl bg-white p-6 text-center text-sm text-stone-500">No orders yet. Add dishes from the menu.</p>}
            <div className="space-y-3">
              {data.orders.slice().reverse().map((o) => {
                const items = data.items.filter((i) => i.order_id === o.id)
                const done = items.filter((i) => i.status === 'ready' || i.status === 'served').length
                const eta = minutesUntil(o.estimated_ready_at, now)
                return (
                  <div key={o.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone-100">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">Order #{o.order_no}</span>
                      {o.status === 'served' ? <Badge tone="green">Served</Badge> : <Badge tone="amber">In the kitchen</Badge>}
                    </div>
                    {o.status === 'open' && (
                      <>
                        <p className="mt-1 text-sm text-stone-700">
                          {eta === null ? 'Working out your waiting time…' : eta <= 1 ? 'Almost ready' : `Ready in about ${eta} min`}
                        </p>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100">
                          <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${items.length ? Math.max(6, (done / items.length) * 100) : 0}%` }} />
                        </div>
                      </>
                    )}
                    <ul className="mt-3 space-y-1.5">
                      {items.map((i) => (
                        <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                          <span>
                            {i.name}
                            {i.size_name ? <span className="text-stone-500"> · {i.size_name}</span> : null}
                            <span className="text-xs text-stone-400"> · {guestName(i.guest_id)}</span>
                          </span>
                          <Badge tone={ITEM_STATUS[i.status].tone}>{ITEM_STATUS[i.status].label}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {tab === 'bill' && (
          <BillTab data={data} guestId={guestId} allServed={allServed} busy={busy} run={run} sessionId={sessionId} guestName={guestName} />
        )}
      </main>

      {/* call waiter */}
      <button
        onClick={() => setCallOpen(true)}
        className="fixed bottom-24 right-4 z-20 flex h-14 items-center gap-2 rounded-full bg-saffron-500 px-5 font-semibold text-white shadow-lg"
        style={{ right: 'max(1rem, calc(50vw - 13rem))' }}
      >
        🔔 Call waiter
        {data.calls.some((c) => c.status === 'open') && <span className="h-2.5 w-2.5 rounded-full bg-white" />}
      </button>

      {/* cart bar */}
      {tab === 'menu' && cartCount > 0 && (
        <button
          onClick={() => setTab('cart')}
          className="fixed inset-x-0 bottom-16 z-20 mx-auto flex w-[calc(100%-2rem)] max-w-[26rem] items-center justify-between rounded-2xl bg-brand-600 px-4 py-3 font-semibold text-white shadow-lg"
        >
          <span>{cartCount} in the shared cart</span>
          <span>View cart · {rs(cartTotal)}</span>
        </button>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto grid max-w-md grid-cols-4 border-t border-stone-200 bg-white pb-[env(safe-area-inset-bottom)]">
        {(
          [
            ['menu', 'Menu', '📖', 0],
            ['cart', 'Cart', '🛒', cartCount],
            ['orders', 'Orders', '🍽', openOrders.length],
            ['bill', 'Bill', '🧾', 0],
          ] as [Tab, string, string, number][]
        ).map(([id, label, icon, count]) => (
          <button key={id} onClick={() => setTab(id)} className={`relative flex flex-col items-center py-2.5 text-xs font-medium ${tab === id ? 'text-brand-700' : 'text-stone-500'}`}>
            <span className="text-xl leading-6">{icon}</span>
            {label}
            {count > 0 && (
              <span className="absolute right-[26%] top-1 min-w-5 rounded-full bg-saffron-500 px-1.5 text-center text-[11px] font-bold text-white">{count}</span>
            )}
          </button>
        ))}
      </nav>

      <AddSheet
        item={picked}
        menu={menu}
        onClose={() => setPicked(null)}
        onAdd={async (sizeId, qty, notes) => {
          const ok = await run(() =>
            guestDb.from('cart_items').insert({ session_id: sessionId, guest_id: guestId, menu_item_id: picked!.id, size_id: sizeId, qty, notes }),
          )
          if (ok) setPicked(null)
        }}
        busy={busy}
      />

      <Sheet open={callOpen} onClose={() => setCallOpen(false)} title="Call a waiter">
        <p className="mb-3 text-sm text-stone-600">Pick what you need. Your table lights up on the staff floor map.</p>
        <div className="grid grid-cols-2 gap-2">
          {CALL_REASONS.map((r) => {
            const open = data.calls.find((c) => c.reason === r.reason && c.status === 'open')
            return (
              <button
                key={r.reason}
                disabled={busy || !!open}
                onClick={() => run(() => guestDb.rpc('call_waiter', { p_session: sessionId, p_reason: r.reason }))}
                className={`flex min-h-20 flex-col items-center justify-center rounded-2xl border p-3 text-sm font-medium ${
                  open ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 bg-white'
                }`}
              >
                <span className="text-2xl">{r.icon}</span>
                {r.label}
                {open && <span className="text-xs font-normal">Waiter notified ✓</span>}
              </button>
            )
          })}
        </div>
        {data.calls.some((c) => c.status === 'acknowledged') && (
          <p className="mt-3 text-center text-sm text-brand-700">A waiter has seen your last request and is on the way.</p>
        )}
      </Sheet>
    </div>
  )
}

function WaitBanner({ orders, now }: { orders: Order[]; now: number }) {
  const etas = orders.map((o) => minutesUntil(o.estimated_ready_at, now)).filter((e): e is number => e !== null)
  const eta = etas.length ? Math.max(...etas) : null
  return (
    <div className="mt-3 flex items-center gap-3 rounded-2xl bg-white/10 px-3 py-2">
      <span className="text-2xl">⏱</span>
      <div>
        <p className="text-sm font-semibold">
          {eta === null ? 'Your order is with the kitchen' : eta <= 1 ? 'Your food is almost ready' : `Your food should be ready in about ${eta} min`}
        </p>
        <p className="text-xs text-brand-100">Live estimate from the kitchen schedule. Dishes are timed to arrive together.</p>
      </div>
    </div>
  )
}

function AddSheet({
  item,
  menu,
  onClose,
  onAdd,
  busy,
}: {
  item: MenuItem | null
  menu: MenuData
  onClose: () => void
  onAdd: (sizeId: string | null, qty: number, notes: string) => void
  busy: boolean
}) {
  const sizes = item ? menu.sizes.filter((s) => s.menu_item_id === item.id) : []
  const [sizeId, setSizeId] = useState<string | null>(null)
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')
  const [forItem, setForItem] = useState<string | null>(null)

  // reset the form whenever a different dish is opened
  if (item && forItem !== item.id) {
    setForItem(item.id)
    setSizeId(sizes[0]?.id ?? null)
    setQty(1)
    setNotes('')
  }
  if (!item) return null
  const size = sizes.find((s) => s.id === sizeId) ?? null
  const { price, full, deal } = priceOf(menu, item, size)

  return (
    <Sheet open onClose={onClose} title={item.name}>
      <p className="text-sm text-stone-600">{item.description}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.spice_level > 0 && <Badge tone="red">{'🌶'.repeat(item.spice_level)} spice</Badge>}
        {item.allergens.map((a) => (
          <Badge key={a} tone="blue">contains {a}</Badge>
        ))}
        <Badge>about {size?.prep_minutes ?? item.prep_minutes} min</Badge>
      </div>

      {sizes.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-sm font-semibold">Size</p>
          <div className="space-y-2">
            {sizes.map((s) => (
              <button
                key={s.id}
                onClick={() => setSizeId(s.id)}
                className={`flex w-full items-center justify-between rounded-xl border px-3 py-3 text-sm ${
                  s.id === sizeId ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-stone-200'
                }`}
              >
                <span>{s.name}</span>
                <span>{rs(priceOf(menu, item, s).price)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="mt-4 block text-sm font-semibold">
        Note for the kitchen <span className="font-normal text-stone-500">(optional)</span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={140}
          placeholder="e.g. no onions, less spicy"
          className="mt-1.5 w-full rounded-xl border border-stone-300 px-3 py-3 text-base font-normal"
        />
      </label>

      <div className="mt-5 flex items-center gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="h-11 w-11 rounded-full border border-stone-300 text-xl" aria-label="One fewer">
            −
          </button>
          <span className="w-5 text-center text-lg font-bold">{qty}</span>
          <button onClick={() => setQty((q) => Math.min(20, q + 1))} className="h-11 w-11 rounded-full border border-stone-300 text-xl" aria-label="One more">
            +
          </button>
        </div>
        <Button size="lg" className="flex-1" disabled={busy} onClick={() => onAdd(sizeId, qty, notes.trim())}>
          Add · {rs(price * qty)}
        </Button>
      </div>
      {deal && (
        <p className="mt-2 text-center text-xs text-saffron-600">
          {deal.title}: {deal.percent_off}% off, was {rs(full)}
        </p>
      )}
    </Sheet>
  )
}

function BillTab({
  data,
  guestId,
  allServed,
  busy,
  run,
  sessionId,
  guestName,
}: {
  data: SessionData
  guestId: string
  allServed: boolean
  busy: boolean
  run: (fn: () => PromiseLike<{ error: unknown }>) => Promise<boolean>
  sessionId: string
  guestName: (id: string | null) => string
}) {
  const [paying, setPaying] = useState<BillShare | null>(null)
  const items = data.items.filter((i) => i.status !== 'cancelled')
  const running = items.reduce((n, i) => n + i.unit_price * i.qty, 0)
  const bill = data.bill
  const anyPaid = data.shares.some((s) => s.status === 'paid')
  const tipPercent = bill && bill.subtotal > 0 ? Math.round((bill.tip / bill.subtotal) * 100) : 0

  // one line per dish and guest
  const lines = useMemo(() => {
    const map = new Map<string, { name: string; guest: string | null; qty: number; total: number }>()
    for (const i of items) {
      const key = `${i.name}|${i.size_name ?? ''}|${i.guest_id ?? ''}`
      const cur = map.get(key) ?? { name: i.size_name ? `${i.name} (${i.size_name})` : i.name, guest: i.guest_id, qty: 0, total: 0 }
      cur.qty += i.qty
      cur.total += i.unit_price * i.qty
      map.set(key, cur)
    }
    return [...map.values()]
  }, [items])

  const setSplit = (mode: Bill['split_mode'], tip: number) =>
    run(() => guestDb.rpc('set_bill_split', { p_session: sessionId, p_mode: mode, p_tip_percent: tip }))

  return (
    <section>
      <h2 className="mb-3 text-lg font-bold">Bill</h2>
      {items.length === 0 ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-stone-500">Nothing ordered yet.</p>
      ) : (
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone-100">
          <ul className="space-y-1.5 text-sm">
            {lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>
                  {l.qty} × {l.name} <span className="text-xs text-stone-400">· {guestName(l.guest)}</span>
                </span>
                <span>{rs(l.total)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 space-y-1 border-t border-stone-200 pt-3 text-sm">
            <Row label="Subtotal" value={rs(bill?.subtotal ?? running)} />
            {bill && <Row label="Sales tax" value={rs(bill.tax)} />}
            {bill && bill.tip > 0 && <Row label="Tip" value={rs(bill.tip)} />}
            <div className="flex justify-between pt-1 text-base font-bold">
              <span>{bill ? 'Total' : 'Total so far (before tax)'}</span>
              <span>{rs(bill?.total ?? running)}</span>
            </div>
          </div>
        </div>
      )}

      {!bill && items.length > 0 && (
        <div className="mt-4">
          {!allServed && <Notice tone="amber">You can ask for the bill once everything has been served.</Notice>}
          <Button size="lg" className="mt-3 w-full" disabled={busy || !allServed} onClick={() => run(() => guestDb.rpc('request_bill', { p_session: sessionId }))}>
            Pay the bill
          </Button>
        </div>
      )}

      {bill && bill.status === 'open' && (
        <>
          <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone-100">
            <p className="mb-2 text-sm font-semibold">Split</p>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['whole', 'One bill'],
                  ['equal', 'Equally'],
                  ['by_guest', 'By who ordered'],
                ] as [Bill['split_mode'], string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  disabled={busy || anyPaid}
                  onClick={() => setSplit(mode, tipPercent)}
                  className={`min-h-11 rounded-xl border px-2 py-2 text-sm font-medium ${
                    bill.split_mode === mode ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-stone-200'
                  } ${anyPaid ? 'opacity-50' : ''}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mb-2 mt-4 text-sm font-semibold">Tip</p>
            <div className="grid grid-cols-4 gap-2">
              {[0, 5, 10, 15].map((t) => (
                <button
                  key={t}
                  disabled={busy || anyPaid}
                  onClick={() => setSplit(bill.split_mode, t)}
                  className={`min-h-11 rounded-xl border py-2 text-sm font-medium ${
                    tipPercent === t ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-stone-200'
                  } ${anyPaid ? 'opacity-50' : ''}`}
                >
                  {t === 0 ? 'No tip' : `${t}%`}
                </button>
              ))}
            </div>
            {anyPaid && <p className="mt-2 text-xs text-stone-500">The split is locked because part of the bill has been paid.</p>}
          </div>

          <div className="mt-4 space-y-2">
            {data.shares.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-stone-100">
                <div>
                  <div className="font-semibold">{s.guest_id === guestId && bill.split_mode !== 'whole' ? 'Your share' : s.label}</div>
                  <div className="text-sm text-stone-600">
                    {rs(s.amount + s.tip)}
                    {s.tip > 0 && <span className="text-xs text-stone-400"> incl. {rs(s.tip)} tip</span>}
                  </div>
                </div>
                {s.status === 'paid' ? (
                  <Badge tone="green">Paid · {PAY_METHODS.find((m) => m.id === s.method)?.label ?? s.method}</Badge>
                ) : (
                  <Button variant={s.guest_id === guestId || bill.split_mode === 'whole' ? 'primary' : 'secondary'} disabled={busy} onClick={() => setPaying(s)}>
                    Pay {rs(s.amount + s.tip)}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <Sheet open={!!paying} onClose={() => setPaying(null)} title="Choose how to pay">
        <div className="mb-3 flex items-center gap-2">
          <Simulated>Simulated payment</Simulated>
        </div>
        <p className="mb-3 text-sm text-stone-600">
          This is a demonstration. No money moves and no payment provider is contacted. Choosing a method only records it and marks{' '}
          <b>{paying ? rs(paying.amount + paying.tip) : ''}</b> as paid.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {PAY_METHODS.map((m) => (
            <button
              key={m.id}
              disabled={busy}
              onClick={async () => {
                const ok = await run(() => guestDb.rpc('pay_share', { p_share: paying!.id, p_method: m.id }))
                if (ok) setPaying(null)
              }}
              className="min-h-14 rounded-xl border border-stone-200 bg-white px-3 py-3 text-sm font-semibold active:bg-stone-50"
            >
              {m.label}
            </button>
          ))}
        </div>
      </Sheet>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-stone-600">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}
