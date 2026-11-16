import { todaySlots } from '../../lib/slots'
import { useMemo, useState, type FormEvent } from 'react'
import { useStaff } from '../../components/StaffShell'
import { Badge, Button, Card, Notice, Spinner } from '../../components/ui'
import { useLive, useNow } from '../../hooks/useLive'
import { friendly, minutesSince, RESTAURANT_ZONE, timeOfDay } from '../../lib/format'
import { staffDb } from '../../lib/supabase'
import type { Reservation, TableRow, WaitlistEntry } from '../../lib/types'

type TableLite = Pick<TableRow, 'id' | 'label' | 'capacity' | 'state'>

interface Data {
  entries: WaitlistEntry[]
  reservations: Reservation[]
  tables: TableLite[]
}

const INPUT = 'mt-1 block min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm'
const SIZES = Array.from({ length: 12 }, (_, i) => i + 1)

const RES_TONE: Record<Reservation['status'], 'blue' | 'green' | 'stone' | 'red'> = {
  booked: 'blue',
  seated: 'green',
  cancelled: 'stone',
  no_show: 'red',
}

export default function Waitlist() {
  const member = useStaff()
  const branch = member.branch_id
  const now = useNow()

  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [walkName, setWalkName] = useState('')
  const [walkSize, setWalkSize] = useState(2)
  const [walkPhone, setWalkPhone] = useState('')

  const [resName, setResName] = useState('')
  const [resPhone, setResPhone] = useState('')
  const [resSize, setResSize] = useState(2)
  const [resSlot, setResSlot] = useState('')

  const { data, error, loading, refresh } = useLive<Data>(
    staffDb,
    async () => {
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart)
      dayEnd.setDate(dayEnd.getDate() + 1)
      const [e, r, t] = await Promise.all([
        staffDb
          .from('waitlist_entries')
          .select('id, name, phone, party_size, status, offered_table_id, created_at')
          .eq('branch_id', branch)
          .in('status', ['waiting', 'offered'])
          .order('created_at', { ascending: true }),
        staffDb
          .from('reservations')
          .select('id, name, phone, party_size, slot_start, table_id, status')
          .eq('branch_id', branch)
          .gte('slot_start', dayStart.toISOString())
          .lt('slot_start', dayEnd.toISOString())
          .order('slot_start', { ascending: true }),
        staffDb.from('tables').select('id, label, capacity, state').eq('branch_id', branch).order('label', { ascending: true }),
      ])
      const failed = e.error ?? r.error ?? t.error
      if (failed) throw new Error(friendly(failed))
      return {
        entries: (e.data ?? []) as WaitlistEntry[],
        reservations: (r.data ?? []) as Reservation[],
        tables: (t.data ?? []) as TableLite[],
      }
    },
    [
      { table: 'waitlist_entries', filter: `branch_id=eq.${branch}` },
      { table: 'reservations', filter: `branch_id=eq.${branch}` },
      { table: 'tables', filter: `branch_id=eq.${branch}` },
    ],
    [branch],
  )

  const slotMinute = Math.floor(now / 60000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slots = useMemo(() => todaySlots(Date.now(), RESTAURANT_ZONE), [slotMinute])
  const chosenSlot = slots.includes(resSlot) ? resSlot : ''

  const tableById = useMemo(() => new Map((data?.tables ?? []).map((t) => [t.id, t])), [data])

  /** Runs one database call, shows its error, and refreshes the lists. Returns true on success. */
  async function run(key: string, call: () => PromiseLike<{ error: { message: string } | null }>): Promise<boolean> {
    setBusy(key)
    setActionError(null)
    let ok = false
    try {
      const { error } = await call()
      if (error) setActionError(friendly(error))
      else ok = true
    } catch (err) {
      setActionError(friendly(err))
    }
    await refresh()
    setBusy(null)
    return ok
  }

  async function addWalkIn(e: FormEvent) {
    e.preventDefault()
    const ok = await run('walkin', () =>
      staffDb.rpc('join_waitlist', {
        p_branch: branch,
        p_name: walkName.trim(),
        p_party_size: walkSize,
        p_phone: walkPhone.trim() || null,
      }),
    )
    if (ok) {
      setWalkName('')
      setWalkPhone('')
      setWalkSize(2)
    }
  }

  async function addReservation(e: FormEvent) {
    e.preventDefault()
    if (!chosenSlot) return setActionError('Pick a time for the reservation.')
    const ok = await run('reservation', () =>
      staffDb.rpc('create_reservation', {
        p_branch: branch,
        p_name: resName.trim(),
        p_phone: resPhone.trim(),
        p_party_size: resSize,
        p_slot: chosenSlot,
      }),
    )
    if (ok) {
      setResName('')
      setResPhone('')
      setResSize(2)
      setResSlot('')
    }
  }

  if (!data) {
    if (loading) return <Spinner label="Loading the waitlist" />
    return <Notice>{error ? friendly(error) : 'Could not load the waitlist.'}</Notice>
  }

  const { entries, reservations } = data
  const offers = entries.filter((e) => e.status === 'offered')
  const anyBusy = busy !== null

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold">Waitlist and reservations</h1>
        <p className="mt-1 text-sm text-stone-600">
          Rule: when a table is marked cleared, it is offered to the first waiting group that fits its capacity. A table with a
          reservation in the next hour is held back and not offered.
        </p>
      </div>

      {error && <Notice tone="amber">Live updates are having trouble ({friendly(error)}). Retrying…</Notice>}
      {actionError && <Notice>{actionError}</Notice>}

      {offers.length > 0 && (
        <section className="space-y-2" aria-label="Table offers">
          {offers.map((e) => {
            const t = e.offered_table_id ? tableById.get(e.offered_table_id) : undefined
            return (
              <div key={e.id} className="rounded-2xl border-2 border-saffron-500 bg-saffron-100 p-4">
                <p className="text-base font-bold">
                  {t ? `Table ${t.label} (seats ${t.capacity})` : 'A table'} is free → offer to {e.name}, group of {e.party_size}
                </p>
                <p className="mt-0.5 text-sm text-stone-700">
                  Waiting {minutesSince(e.created_at, now)} min{e.phone ? ` · ${e.phone}` : ''}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={anyBusy}
                    onClick={() => void run(`offer-${e.id}`, () => staffDb.rpc('staff_resolve_offer', { p_entry: e.id, p_seat: true }))}
                  >
                    Seat them
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={anyBusy}
                    onClick={() => void run(`offer-${e.id}`, () => staffDb.rpc('staff_resolve_offer', { p_entry: e.id, p_seat: false }))}
                  >
                    No-show / pass
                  </Button>
                </div>
              </div>
            )
          })}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ------------------------------------------------------------ queue */}
        <section className="space-y-3">
          <Card className="p-4">
            <h2 className="text-xl font-bold">Queue ({entries.length})</h2>
            {entries.length === 0 ? (
              <p className="mt-2 text-sm text-stone-500">Nobody is waiting.</p>
            ) : (
              <ul className="mt-2 divide-y divide-stone-100">
                {entries.map((e, i) => {
                  const t = e.offered_table_id ? tableById.get(e.offered_table_id) : undefined
                  return (
                    <li key={e.id} className="flex items-center gap-3 py-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-sm font-bold">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">
                          {e.name} <span className="font-normal text-stone-600">· group of {e.party_size}</span>
                        </p>
                        <p className="truncate text-xs text-stone-500">
                          Waiting {minutesSince(e.created_at, now)} min · since {timeOfDay(e.created_at)}
                          {e.phone ? ` · ${e.phone}` : ' · no phone'}
                        </p>
                      </div>
                      {e.status === 'offered' ? (
                        <Badge tone="amber">Offered{t ? ` ${t.label}` : ''}</Badge>
                      ) : (
                        <>
                          <Badge>Waiting</Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={anyBusy}
                            onClick={() => {
                              if (window.confirm(`Remove ${e.name} from the queue?`))
                                void run(`remove-${e.id}`, () => staffDb.rpc('leave_waitlist', { p_entry: e.id }))
                            }}
                          >
                            Remove
                          </Button>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-xl font-bold">Add walk-in</h2>
            <form onSubmit={addWalkIn} className="mt-2 grid grid-cols-2 gap-3">
              <label className="col-span-2 block text-sm font-medium sm:col-span-1">
                Name
                <input className={INPUT} value={walkName} onChange={(e) => setWalkName(e.target.value)} required maxLength={40} />
              </label>
              <label className="block text-sm font-medium">
                Group size
                <select className={INPUT} value={walkSize} onChange={(e) => setWalkSize(Number(e.target.value))}>
                  {SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium">
                Phone (optional)
                <input className={INPUT} type="tel" value={walkPhone} onChange={(e) => setWalkPhone(e.target.value)} maxLength={20} />
              </label>
              <div className="col-span-2">
                <Button type="submit" disabled={anyBusy || !walkName.trim()}>
                  {busy === 'walkin' ? 'Adding…' : 'Add to queue'}
                </Button>
              </div>
            </form>
          </Card>
        </section>

        {/* ----------------------------------------------------- reservations */}
        <section className="space-y-3">
          <Card className="p-4">
            <h2 className="text-xl font-bold">Reservations today ({reservations.filter((r) => r.status === 'booked').length} booked)</h2>
            {reservations.length === 0 ? (
              <p className="mt-2 text-sm text-stone-500">No reservations today.</p>
            ) : (
              <ul className="mt-2 divide-y divide-stone-100">
                {reservations.map((r) => {
                  const t = r.table_id ? tableById.get(r.table_id) : undefined
                  return (
                    <li key={r.id} className="py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="w-16 shrink-0 text-sm font-bold">{timeOfDay(r.slot_start)}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold">
                            {r.name} <span className="font-normal text-stone-600">· group of {r.party_size}</span>
                          </p>
                          <p className="truncate text-xs text-stone-500">
                            {t ? `Table ${t.label} (seats ${t.capacity})` : 'No table'}
                            {r.phone ? ` · ${r.phone}` : ''}
                          </p>
                        </div>
                        <Badge tone={RES_TONE[r.status]}>{r.status === 'no_show' ? 'no-show' : r.status}</Badge>
                      </div>
                      {r.status === 'booked' && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 pl-[4.75rem]">
                          <Button
                            size="sm"
                            disabled={anyBusy}
                            onClick={() =>
                              void run(`res-${r.id}`, () => staffDb.rpc('staff_resolve_reservation', { p_reservation: r.id, p_seat: true }))
                            }
                          >
                            Seat
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={anyBusy}
                            onClick={() =>
                              void run(`res-${r.id}`, () => staffDb.rpc('staff_resolve_reservation', { p_reservation: r.id, p_seat: false }))
                            }
                          >
                            No-show
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={anyBusy}
                            onClick={() => {
                              if (window.confirm(`Cancel the ${timeOfDay(r.slot_start)} reservation for ${r.name}?`))
                                void run(`res-${r.id}`, () => staffDb.rpc('cancel_reservation', { p_reservation: r.id }))
                            }}
                          >
                            Cancel
                          </Button>
                          {t && t.state !== 'free' && <span className="text-xs text-amber-800">Table {t.label} is not free yet</span>}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-xl font-bold">Add reservation</h2>
            <form onSubmit={addReservation} className="mt-2 grid grid-cols-2 gap-3">
              <label className="block text-sm font-medium">
                Name
                <input className={INPUT} value={resName} onChange={(e) => setResName(e.target.value)} required maxLength={40} />
              </label>
              <label className="block text-sm font-medium">
                Phone
                <input className={INPUT} type="tel" value={resPhone} onChange={(e) => setResPhone(e.target.value)} maxLength={20} />
              </label>
              <label className="block text-sm font-medium">
                Group size
                <select className={INPUT} value={resSize} onChange={(e) => setResSize(Number(e.target.value))}>
                  {SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium">
                Time today
                <select className={INPUT} value={chosenSlot} onChange={(e) => setResSlot(e.target.value)} disabled={slots.length === 0}>
                  <option value="">{slots.length === 0 ? 'No times left today' : 'Pick a time'}</option>
                  {slots.map((s) => (
                    <option key={s} value={s}>
                      {timeOfDay(s)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="col-span-2">
                <Button type="submit" disabled={anyBusy || !resName.trim() || !chosenSlot}>
                  {busy === 'reservation' ? 'Booking…' : 'Book table'}
                </Button>
              </div>
            </form>
          </Card>
        </section>
      </div>
    </div>
  )
}
