import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, Notice, Spinner } from '../../components/ui'
import { useLive, useNow } from '../../hooks/useLive'
import { friendly, timeOfDay } from '../../lib/format'
import { BRANCH_ID, ensureGuest, guestDb, withGuestSuffix } from '../../lib/supabase'
import type { Reservation, WaitlistEntry } from '../../lib/types'

interface QueueStatus {
  status: WaitlistEntry['status']
  party_size: number
  name: string
  position: number
  waiting_total: number
  table_label: string | null
  table_token: string | null
}

type Tab = 'queue' | 'reserve'

const INPUT = 'mt-1 block w-full min-h-11 rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-base'

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  const unit = n % 10
  return `${n}${unit === 1 ? 'st' : unit === 2 ? 'nd' : unit === 3 ? 'rd' : 'th'}`
}

/** 30-minute slots from the next half hour until 23:00 today (local time). */
function todaySlots(now: number): string[] {
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60)
  const end = new Date(now)
  end.setHours(23, 0, 0, 0)
  const out: string[] = []
  while (d.getTime() <= end.getTime()) {
    out.push(d.toISOString())
    d.setMinutes(d.getMinutes() + 30)
  }
  return out
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // private browsing: the page still works, it just forgets on reload
  }
}

function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const step = 'h-12 w-12 shrink-0 rounded-xl border border-stone-300 bg-white text-2xl font-semibold disabled:text-stone-300'
  return (
    <div className="mt-1 flex items-center gap-3">
      <button type="button" className={step} disabled={value <= 1} onClick={() => onChange(value - 1)} aria-label="Fewer people">
        −
      </button>
      <span className="min-w-20 text-center text-lg font-bold" aria-live="polite">
        {value} {value === 1 ? 'person' : 'people'}
      </span>
      <button type="button" className={step} disabled={value >= 12} onClick={() => onChange(value + 1)} aria-label="More people">
        +
      </button>
    </div>
  )
}

function MenuLink({ token }: { token: string }) {
  return (
    <Link
      to={withGuestSuffix(`/t/${token}`)}
      className="flex min-h-14 w-full items-center justify-center rounded-xl bg-saffron-500 px-5 py-3.5 text-center text-base font-bold text-white hover:bg-saffron-600"
    >
      Open the menu for my table
    </Link>
  )
}

function StatusCard({ children }: { children: ReactNode }) {
  return <Card className="space-y-4 p-5 text-center">{children}</Card>
}

/* ------------------------------------------------------------------ queue */

function QueueLive({ entryId, onClear }: { entryId: string; onClear: () => void }) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, error, loading } = useLive<QueueStatus | null>(
    guestDb,
    async () => {
      await ensureGuest()
      const { data, error } = await guestDb.rpc('waitlist_status', { p_entry: entryId })
      if (error) throw new Error(friendly(error))
      return (data as QueueStatus | null) ?? null
    },
    [{ table: 'waitlist_entries' }],
    [entryId],
    { pollMs: 5000 },
  )

  async function leave() {
    if (!window.confirm('Leave the queue? You will lose your place.')) return
    setBusy(true)
    setActionError(null)
    const { error } = await guestDb.rpc('leave_waitlist', { p_entry: entryId })
    setBusy(false)
    if (error) setActionError(friendly(error))
    else onClear()
  }

  if (data === undefined) {
    if (loading) return <Spinner label="Finding your place in the queue" />
    return (
      <div className="space-y-3">
        <Notice>{error ? friendly(error) : 'Could not load your place in the queue.'}</Notice>
        <p className="text-center text-sm text-stone-500">Trying again automatically…</p>
      </div>
    )
  }

  if (data === null) {
    return (
      <StatusCard>
        <p className="text-lg font-bold">We could not find your place in the queue</p>
        <p className="text-sm text-stone-600">It may have been removed, or this phone&apos;s guest identity changed.</p>
        <Button size="lg" className="w-full" onClick={onClear}>
          Join again
        </Button>
      </StatusCard>
    )
  }

  const table = data.table_label ? `Table ${data.table_label}` : 'a table'
  const ahead = Math.max(0, data.position - 1)

  return (
    <div className="space-y-3">
      {error && <Notice tone="amber">Connection problem, showing the last known position. Retrying…</Notice>}
      {actionError && <Notice>{actionError}</Notice>}

      {data.status === 'waiting' && (
        <StatusCard>
          <p className="text-sm font-medium uppercase tracking-wide text-stone-500">You are</p>
          <p className="text-7xl font-extrabold leading-none text-brand-600">{ordinal(data.position)}</p>
          <p className="text-lg font-bold">in line</p>
          <p className="text-sm text-stone-600">
            {ahead === 0 ? 'You are next. Please stay close to the host stand.' : `${ahead} ${ahead === 1 ? 'group' : 'groups'} ahead of you`}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Badge tone="blue">
              {data.name} · group of {data.party_size}
            </Badge>
            <Badge>{data.waiting_total} waiting in total</Badge>
          </div>
          <p className="text-xs text-stone-500">This page updates by itself. Keep it open.</p>
        </StatusCard>
      )}

      {data.status === 'offered' && (
        <StatusCard>
          <Badge tone="amber">Almost there</Badge>
          <p className="text-2xl font-extrabold text-saffron-600">A table is being prepared for you: {table}.</p>
          <p className="text-base font-medium">Please come to the host stand.</p>
          <p className="text-sm text-stone-600">
            {data.name} · group of {data.party_size}
          </p>
        </StatusCard>
      )}

      {data.status === 'seated' && (
        <StatusCard>
          <Badge tone="green">Seated</Badge>
          <p className="text-2xl font-extrabold text-brand-600">Your {table.replace('Table', 'table')} is ready</p>
          <p className="text-sm text-stone-600">Order from your phone as soon as you sit down.</p>
          {data.table_token ? (
            <MenuLink token={data.table_token} />
          ) : (
            <p className="text-sm text-stone-600">Scan the QR code on your table to open the menu.</p>
          )}
          <button type="button" onClick={onClear} className="min-h-11 text-sm text-stone-500 underline">
            Done, clear this
          </button>
        </StatusCard>
      )}

      {(data.status === 'cancelled' || data.status === 'no_show') && (
        <StatusCard>
          <p className="text-xl font-bold">
            {data.status === 'cancelled' ? 'You are no longer in the queue' : 'We called your group but could not find you'}
          </p>
          <p className="text-sm text-stone-600">
            {data.status === 'cancelled'
              ? 'Your place was cancelled. You can join again whenever you like.'
              : 'Your table was passed to the next group. Join again and we will seat you as soon as we can.'}
          </p>
          <Button size="lg" className="w-full" onClick={onClear}>
            Join the queue again
          </Button>
        </StatusCard>
      )}

      {(data.status === 'waiting' || data.status === 'offered') && (
        <Button variant="secondary" size="lg" className="w-full" disabled={busy} onClick={leave}>
          {busy ? 'Leaving…' : 'Leave the queue'}
        </Button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ reservation */

function ReservationLive({ reservationId, onClear }: { reservationId: string; onClear: () => void }) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, error, loading, refresh } = useLive<{ row: Reservation | null; token: string | null }>(
    guestDb,
    async () => {
      await ensureGuest()
      const { data: row, error } = await guestDb
        .from('reservations')
        .select('id, name, phone, party_size, slot_start, table_id, status')
        .eq('id', reservationId)
        .maybeSingle()
      if (error) throw new Error(friendly(error))
      const res = (row as Reservation | null) ?? null
      let token: string | null = null
      if (res?.status === 'seated') {
        const { data: t, error: tokenError } = await guestDb.rpc('reservation_token', { p_reservation: reservationId })
        if (tokenError) throw new Error(friendly(tokenError))
        token = (t as string | null) ?? null
      }
      return { row: res, token }
    },
    [{ table: 'reservations' }],
    [reservationId],
    { pollMs: 5000 },
  )

  async function cancel() {
    if (!window.confirm('Cancel this reservation?')) return
    setBusy(true)
    setActionError(null)
    const { error } = await guestDb.rpc('cancel_reservation', { p_reservation: reservationId })
    setBusy(false)
    if (error) setActionError(friendly(error))
    else await refresh()
  }

  if (data === undefined) {
    if (loading) return <Spinner label="Loading your reservation" />
    return <Notice>{error ? friendly(error) : 'Could not load your reservation.'}</Notice>
  }

  const row = data.row
  if (!row) {
    return (
      <StatusCard>
        <p className="text-lg font-bold">We could not find your reservation</p>
        <Button size="lg" className="w-full" onClick={onClear}>
          Make a new reservation
        </Button>
      </StatusCard>
    )
  }

  return (
    <div className="space-y-3">
      {error && <Notice tone="amber">Connection problem. Retrying…</Notice>}
      {actionError && <Notice>{actionError}</Notice>}

      {row.status === 'booked' && (
        <StatusCard>
          <Badge tone="green">Reservation confirmed</Badge>
          <p className="text-5xl font-extrabold leading-none text-brand-600">{timeOfDay(row.slot_start)}</p>
          <p className="text-base font-medium">
            today · {row.name} · group of {row.party_size}
          </p>
          <p className="text-sm text-stone-600">A table is held for you. Please tell the host your name when you arrive.</p>
        </StatusCard>
      )}

      {row.status === 'seated' && (
        <StatusCard>
          <Badge tone="green">Seated</Badge>
          <p className="text-2xl font-extrabold text-brand-600">Your table is ready</p>
          {data.token ? (
            <MenuLink token={data.token} />
          ) : (
            <p className="text-sm text-stone-600">Scan the QR code on your table to open the menu.</p>
          )}
          <button type="button" onClick={onClear} className="min-h-11 text-sm text-stone-500 underline">
            Done, clear this
          </button>
        </StatusCard>
      )}

      {(row.status === 'cancelled' || row.status === 'no_show') && (
        <StatusCard>
          <p className="text-xl font-bold">
            {row.status === 'cancelled' ? 'This reservation was cancelled' : 'This reservation was marked as a no-show'}
          </p>
          <p className="text-sm text-stone-600">
            {row.status === 'cancelled'
              ? `Your ${timeOfDay(row.slot_start)} booking is no longer held.`
              : `We held your table at ${timeOfDay(row.slot_start)} but did not see you, so it was released.`}
          </p>
          <Button size="lg" className="w-full" onClick={onClear}>
            Reserve again
          </Button>
        </StatusCard>
      )}

      {row.status === 'booked' && (
        <Button variant="secondary" size="lg" className="w-full" disabled={busy} onClick={cancel}>
          {busy ? 'Cancelling…' : 'Cancel reservation'}
        </Button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------- page */

export default function GuestJoin() {
  const [params] = useSearchParams()
  const branch = params.get('branch') || BRANCH_ID
  // a second guest identity (?guest=2) keeps its own stored place
  const suffix = params.get('guest') ?? ''
  const queueKey = `zaiqa-waitlist-${branch}${suffix}`
  const reservationKey = `zaiqa-reservation-${branch}${suffix}`

  const [tab, setTab] = useState<Tab>('queue')
  const [entryId, setEntryId] = useState<string | null>(() => readStored(queueKey))
  const [reservationId, setReservationId] = useState<string | null>(() => readStored(reservationKey))
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [party, setParty] = useState(2)
  const [slot, setSlot] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const now = useNow(30000)
  const slotMinute = Math.floor(now / 60000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slots = useMemo(() => todaySlots(Date.now()), [slotMinute])
  const chosenSlot = slot && slots.includes(slot) ? slot : null

  function storeEntry(id: string | null) {
    writeStored(queueKey, id)
    setEntryId(id)
  }
  function storeReservation(id: string | null) {
    writeStored(reservationKey, id)
    setReservationId(id)
  }

  // If this phone already has a live entry or booking (storage cleared, other tab), pick it up again.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await ensureGuest()
        if (!readStored(queueKey)) {
          const { data } = await guestDb
            .from('waitlist_entries')
            .select('id')
            .eq('branch_id', branch)
            .in('status', ['waiting', 'offered'])
            .order('created_at', { ascending: false })
            .limit(1)
          const found = (data as { id: string }[] | null)?.[0]
          if (found && !cancelled) {
            writeStored(queueKey, found.id)
            setEntryId((cur) => cur ?? found.id)
          }
        }
        if (!readStored(reservationKey)) {
          const { data } = await guestDb
            .from('reservations')
            .select('id')
            .eq('branch_id', branch)
            .eq('status', 'booked')
            .order('slot_start', { ascending: true })
            .limit(1)
          const found = (data as { id: string }[] | null)?.[0]
          if (found && !cancelled) {
            writeStored(reservationKey, found.id)
            setReservationId((cur) => cur ?? found.id)
          }
        }
      } catch (e) {
        if (!cancelled) setError(friendly(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [branch, queueKey, reservationKey])

  async function joinQueue(e: FormEvent) {
    e.preventDefault()
    if (!branch) return setError('This link is missing the restaurant branch. Please ask staff for help.')
    setBusy(true)
    setError(null)
    try {
      await ensureGuest()
      const { data, error } = await guestDb.rpc('join_waitlist', {
        p_branch: branch,
        p_name: name.trim(),
        p_party_size: party,
        p_phone: phone.trim() || null,
      })
      if (error) throw error
      storeEntry(data as string)
    } catch (err) {
      setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  async function reserve(e: FormEvent) {
    e.preventDefault()
    if (!branch) return setError('This link is missing the restaurant branch. Please ask staff for help.')
    if (!chosenSlot) return setError('Please pick a time.')
    setBusy(true)
    setError(null)
    try {
      await ensureGuest()
      const { data, error } = await guestDb.rpc('create_reservation', {
        p_branch: branch,
        p_name: name.trim(),
        p_phone: phone.trim(),
        p_party_size: party,
        p_slot: chosenSlot,
      })
      if (error) throw error
      storeReservation(data as string)
      setSlot(null)
    } catch (err) {
      setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  function switchTab(next: Tab) {
    setTab(next)
    setError(null)
  }

  const tabClass = (active: boolean) =>
    `min-h-11 flex-1 rounded-xl px-2 py-2 text-sm font-semibold transition-colors ${active ? 'bg-brand-600 text-white' : 'text-stone-600 hover:bg-stone-100'}`

  return (
    <div className="min-h-full bg-cream">
      <header className="bg-brand-900 px-4 py-5 text-white">
        <div className="mx-auto max-w-md">
          <p className="text-xs uppercase tracking-widest text-saffron-400">Welcome to</p>
          <h1 className="text-2xl font-bold">Zaiqa Karahi House</h1>
          <p className="mt-1 text-sm text-brand-100">No table yet? Join the queue or reserve for later today.</p>
        </div>
      </header>

      <main className="mx-auto max-w-md space-y-4 p-4 pb-10">
        <div className="flex gap-1 rounded-2xl border border-stone-200 bg-white p-1" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'queue'} className={tabClass(tab === 'queue')} onClick={() => switchTab('queue')}>
            Join the queue
          </button>
          <button type="button" role="tab" aria-selected={tab === 'reserve'} className={tabClass(tab === 'reserve')} onClick={() => switchTab('reserve')}>
            Reserve for later today
          </button>
        </div>

        {error && <Notice>{error}</Notice>}

        {tab === 'queue' &&
          (entryId ? (
            <QueueLive key={entryId} entryId={entryId} onClear={() => storeEntry(null)} />
          ) : (
            <Card className="p-4">
              <form onSubmit={joinQueue} className="space-y-4">
                <label className="block text-sm font-medium">
                  Your name
                  <input
                    className={INPUT}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={40}
                    autoComplete="given-name"
                    placeholder="e.g. Ali"
                  />
                </label>
                <div className="text-sm font-medium">
                  Group size
                  <Stepper value={party} onChange={setParty} />
                </div>
                <label className="block text-sm font-medium">
                  Phone <span className="font-normal text-stone-500">(optional)</span>
                  <input
                    className={INPUT}
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    maxLength={20}
                    autoComplete="tel"
                    placeholder="03xx xxxxxxx"
                  />
                </label>
                <Button type="submit" size="lg" className="w-full" disabled={busy || !name.trim()}>
                  {busy ? 'Joining…' : 'Join the queue'}
                </Button>
                <p className="text-center text-xs text-stone-500">We will show your place in line on this phone.</p>
              </form>
            </Card>
          ))}

        {tab === 'reserve' &&
          (reservationId ? (
            <ReservationLive key={reservationId} reservationId={reservationId} onClear={() => storeReservation(null)} />
          ) : (
            <Card className="p-4">
              <form onSubmit={reserve} className="space-y-4">
                <label className="block text-sm font-medium">
                  Your name
                  <input
                    className={INPUT}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={40}
                    autoComplete="given-name"
                    placeholder="e.g. Ali"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Phone
                  <input
                    className={INPUT}
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                    maxLength={20}
                    autoComplete="tel"
                    placeholder="03xx xxxxxxx"
                  />
                </label>
                <div className="text-sm font-medium">
                  Group size
                  <Stepper value={party} onChange={setParty} />
                </div>
                <div className="text-sm font-medium">
                  Time today
                  {slots.length === 0 ? (
                    <div className="mt-1">
                      <Notice tone="amber">There are no more reservation times today. You can still join the queue.</Notice>
                    </div>
                  ) : (
                    <div className="mt-1 grid grid-cols-3 gap-2">
                      {slots.map((s) => (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={chosenSlot === s}
                          onClick={() => setSlot(s)}
                          className={`min-h-11 rounded-xl border px-1 py-2 text-sm font-semibold ${
                            chosenSlot === s ? 'border-brand-600 bg-brand-600 text-white' : 'border-stone-300 bg-white text-ink hover:bg-stone-50'
                          }`}
                        >
                          {timeOfDay(s)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Button type="submit" size="lg" className="w-full" disabled={busy || !name.trim() || !phone.trim() || !chosenSlot}>
                  {busy ? 'Reserving…' : chosenSlot ? `Reserve for ${timeOfDay(chosenSlot)}` : 'Pick a time'}
                </Button>
              </form>
            </Card>
          ))}
      </main>
    </div>
  )
}
