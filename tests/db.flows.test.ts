/**
 * Integration tests for the flows around the core ordering path: waitlist,
 * reservations, equal bill split, calling a waiter, and session expiry.
 * Run with `npm run test:db`. They act like browsers (public key only) and
 * leave the branch with every table free and no waitlist entries or bookings.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const URL = process.env.VITE_SUPABASE_URL!
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!
const BRANCH = process.env.VITE_DEFAULT_BRANCH_ID!

const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
async function login(email: string, password: string) {
  const c = client()
  const { error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  return c
}
// Supabase limits anonymous sign-ins (about 30 an hour per network by default), so the tests
// share a small pool of guest phones instead of creating a new one each time. State is
// cleaned up between tests, so reusing a phone is safe.
const pool: SupabaseClient[] = []
async function G(i: number): Promise<SupabaseClient> {
  while (pool.length <= i) {
    const c = client()
    const { error } = await c.auth.signInAnonymously()
    if (error) throw new Error(error.message)
    pool.push(c)
  }
  return pool[i]
}

let waiter: SupabaseClient
let owner: SupabaseClient
let tables: { id: string; label: string; capacity: number; token: string }[]
let dish: Record<string, { id: string; price: number }>
let originalSettings: Record<string, unknown>

const byLabel = (l: string) => tables.find((t) => t.label === l)!

/** Every table free, nobody queuing, no bookings. */
async function reset() {
  const wl = await waiter.from('waitlist_entries').select('id').in('status', ['waiting', 'offered'])
  for (const e of wl.data ?? []) await waiter.rpc('leave_waitlist', { p_entry: e.id })
  const rs = await waiter.from('reservations').select('id').eq('status', 'booked')
  for (const r of rs.data ?? []) await waiter.rpc('cancel_reservation', { p_reservation: r.id })
  const ts = await waiter.from('tables').select('id,state').eq('branch_id', BRANCH)
  for (const t of ts.data ?? []) if (t.state !== 'free') await waiter.rpc('staff_close_table', { p_table: t.id })
  const after = await waiter.from('tables').select('id,state').eq('branch_id', BRANCH)
  for (const t of after.data ?? []) if (t.state === 'paid_dirty') await waiter.rpc('staff_clear_table', { p_table: t.id })
  // clearing may have offered a table to someone who joined meanwhile
  const wl2 = await waiter.from('waitlist_entries').select('id').in('status', ['waiting', 'offered'])
  for (const e of wl2.data ?? []) await waiter.rpc('leave_waitlist', { p_entry: e.id })
}

async function tableState(label: string) {
  const { data } = await waiter.from('tables').select('state').eq('id', byLabel(label).id).single()
  return data!.state as string
}

async function status(g: SupabaseClient, id: string) {
  const { data, error } = await g.rpc('waitlist_status', { p_entry: id })
  expect(error).toBeNull()
  return data as { status: string; position: number; table_label: string | null; table_token: string | null }
}

/** A phone scans a table, staff accept: returns the guest row id. */
async function seatGuest(g: SupabaseClient, label: string, name: string) {
  const { data, error } = await g.rpc('request_session', { p_token: byLabel(label).token, p_name: name, p_party_size: 2 })
  expect(error).toBeNull()
  const r = await waiter.rpc('staff_decide_session', { p_session: data.session_id, p_approve: true })
  expect(r.error).toBeNull()
  return { sessionId: data.session_id as string, guestId: data.guest_id as string }
}

beforeAll(async () => {
  waiter = await login(process.env.TEST_WAITER_EMAIL!, process.env.TEST_WAITER_PASSWORD!)
  owner = await login(process.env.TEST_OWNER_EMAIL!, process.env.TEST_OWNER_PASSWORD!)
  const { data, error } = await waiter.rpc('staff_table_tokens', { p_branch: BRANCH })
  if (error) throw error
  tables = data.map((t: { table_id: string; label: string; capacity: number; token: string }) => ({
    id: t.table_id, label: t.label, capacity: t.capacity, token: t.token,
  }))
  const g = await G(0)
  const { data: items } = await g.from('menu_items').select('id,name,price').in('name', ['Plain Naan', 'Roti', 'Soft Drink'])
  dish = Object.fromEntries((items ?? []).map((i) => [i.name, { id: i.id, price: i.price }]))
  const { data: b } = await owner.from('branches').select('settings').eq('id', BRANCH).single()
  originalSettings = b!.settings
  await reset()
})

afterAll(async () => {
  if (owner && originalSettings) await owner.from('branches').update({ settings: originalSettings, timezone: originalZone }).eq('id', BRANCH)
  if (waiter) await reset()
})

describe('waitlist', () => {
  it('a group joining while a table is free is offered one at once, and sees its position', async () => {
    const g = await G(0)
    const { data: id, error } = await g.rpc('join_waitlist', { p_branch: BRANCH, p_name: 'Sana', p_party_size: 2 })
    expect(error).toBeNull()
    const s = await status(g, id)
    expect(s.status).toBe('offered')
    expect(s.position).toBe(1)
    expect(s.table_label).toBeTruthy()
    await reset()
  })

  it('joining twice does not create a second place in the queue', async () => {
    for (const t of tables) await waiter.rpc('staff_seat_table', { p_table: t.id, p_party_size: 2 })
    const g = await G(0)
    const a = await g.rpc('join_waitlist', { p_branch: BRANCH, p_name: 'Sana', p_party_size: 2 })
    const b = await g.rpc('join_waitlist', { p_branch: BRANCH, p_name: 'Sana again', p_party_size: 4 })
    expect(b.data).toBe(a.data)
    await reset()
  })

  it('a freed table goes to the first waiting group that fits, in order', async () => {
    for (const t of tables) expect((await waiter.rpc('staff_seat_table', { p_table: t.id, p_party_size: 2 })).error).toBeNull()
    const [ga, gb, gc] = [await G(0), await G(1), await G(2)]
    const a = (await ga.rpc('join_waitlist', { p_branch: BRANCH, p_name: 'A', p_party_size: 2 })).data
    const b = (await gb.rpc('join_waitlist', { p_branch: BRANCH, p_name: 'B', p_party_size: 6 })).data
    const c = (await gc.rpc('join_waitlist', { p_branch: BRANCH, p_name: 'C', p_party_size: 8 })).data
    expect((await status(ga, a)).position).toBe(1)
    expect((await status(gb, b)).position).toBe(2)
    expect((await status(gc, c)).position).toBe(3)
    expect((await status(gc, c)).status).toBe('waiting')

    // an 8-seat table frees up: the FIRST group (A, party of 2) gets it, even though C needs it more
    await waiter.rpc('staff_close_table', { p_table: byLabel('T12').id })
    expect((await status(ga, a)).status).toBe('offered')
    expect((await status(ga, a)).table_label).toBe('T12')

    // a 6-seat table: next in line that fits is B
    await waiter.rpc('staff_close_table', { p_table: byLabel('T10').id })
    expect((await status(gb, b)).table_label).toBe('T10')

    // a 2-seat table: C (party of 8) does not fit, so it is not offered
    await waiter.rpc('staff_close_table', { p_table: byLabel('T1').id })
    expect((await status(gc, c)).status).toBe('waiting')
    expect(await tableState('T1')).toBe('free')

    // A does not show up: the table passes to the next group that fits (C)
    const pass = await waiter.rpc('staff_resolve_offer', { p_entry: a, p_seat: false })
    expect(pass.error).toBeNull()
    expect((await status(ga, a)).status).toBe('no_show')
    expect((await status(gc, c)).table_label).toBe('T12')
    await reset()
  })

  it('confirming an offer seats the group and lets their phone order', async () => {
    const g = await G(0)
    const id = (await g.rpc('join_waitlist', { p_branch: BRANCH, p_name: 'Hina', p_party_size: 2 })).data
    const offered = await status(g, id)
    const seat = await waiter.rpc('staff_resolve_offer', { p_entry: id, p_seat: true })
    expect(seat.error).toBeNull()
    const s = await status(g, id)
    expect(s.status).toBe('seated')
    expect(s.table_token).toBeTruthy()
    const view = await g.rpc('resolve_table', { p_token: s.table_token })
    expect(view.data.guest_status).toBe('approved')
    expect(view.data.session_status).toBe('open')
    expect(view.data.label).toBe(offered.table_label)
    const add = await g.from('cart_items').insert({ session_id: view.data.session_id, guest_id: view.data.guest_id, menu_item_id: dish['Plain Naan'].id, qty: 1 })
    expect(add.error).toBeNull()
    await reset()
  })

  it('nobody else can read or cancel someone\'s queue entry', async () => {
    for (const t of tables) await waiter.rpc('staff_seat_table', { p_table: t.id, p_party_size: 2 })
    const owner1 = await G(0)
    const other = await G(1)
    const id = (await owner1.rpc('join_waitlist', { p_branch: BRANCH, p_name: 'Private', p_party_size: 2 })).data
    expect((await other.rpc('waitlist_status', { p_entry: id })).data).toBeNull()
    expect((await other.rpc('leave_waitlist', { p_entry: id })).error?.message).toContain('not_allowed')
    expect((await other.from('waitlist_entries').select('id')).data).toHaveLength(0)
    await reset()
  })
})

// Reservations are for "later today in the restaurant's time zone". So that these tests do not
// depend on the hour they run at, they temporarily move the branch to a time zone where it is
// currently mid-day, and put the real zone back afterwards.
let originalZone = 'Asia/Karachi'
const hourIn = (zone: string) => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }).format(new Date()))
const midDayZone = ['Asia/Karachi', 'Pacific/Honolulu', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney'].find((z) => {
  const h = hourIn(z)
  return h >= 2 && h <= 19
})!
describe('reservations', () => {
  beforeAll(async () => {
    const { data } = await owner.from('branches').select('timezone').eq('id', BRANCH).single()
    originalZone = data!.timezone
    const r = await owner.from('branches').update({ timezone: midDayZone }).eq('id', BRANCH).select()
    expect(r.data).toHaveLength(1)
  })
  afterAll(async () => {
    await owner.from('branches').update({ timezone: originalZone }).eq('id', BRANCH)
  })

  it('books a table, refuses a second booking from the same phone, and rejects bad requests', async () => {
    const g = await G(0)
    const slot = new Date(Date.now() + 2 * 3_600_000).toISOString()
    const ok = await g.rpc('create_reservation', { p_branch: BRANCH, p_name: 'Omar', p_phone: '0300', p_party_size: 2, p_slot: slot })
    expect(ok.error).toBeNull()
    const again = await g.rpc('create_reservation', { p_branch: BRANCH, p_name: 'Omar', p_phone: '0300', p_party_size: 2, p_slot: slot })
    expect(again.error?.message).toContain('already_reserved')
    const g2 = await G(1)
    expect((await g2.rpc('create_reservation', { p_branch: BRANCH, p_name: 'X', p_phone: '', p_party_size: 20, p_slot: slot })).error?.message).toContain('party_too_large')
    expect((await g2.rpc('create_reservation', { p_branch: BRANCH, p_name: 'X', p_phone: '', p_party_size: 2, p_slot: new Date(Date.now() - 60_000).toISOString() })).error?.message).toContain('slot_must_be_later_today')
    const tomorrow = new Date(Date.now() + 30 * 3_600_000).toISOString()
    expect((await g2.rpc('create_reservation', { p_branch: BRANCH, p_name: 'X', p_phone: '', p_party_size: 2, p_slot: tomorrow })).error?.message).toContain('slot_must_be_later_today')
    await reset()
  })

  it('two bookings for the same slot never get the same table', async () => {
    const slot = new Date(Date.now() + 2 * 3_600_000).toISOString()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const g = await G(i)
      const r = await g.rpc('create_reservation', { p_branch: BRANCH, p_name: `G${i}`, p_phone: '', p_party_size: 2, p_slot: slot })
      expect(r.error).toBeNull()
      ids.push(r.data)
    }
    const { data } = await waiter.from('reservations').select('table_id').in('id', ids)
    expect(new Set(data!.map((r) => r.table_id)).size).toBe(3)
    await reset()
  })

  it('staff seating a reservation opens the table and gives the guest their menu link', async () => {
    const g = await G(0)
    const slot = new Date(Date.now() + 2 * 3_600_000).toISOString()
    const id = (await g.rpc('create_reservation', { p_branch: BRANCH, p_name: 'Zara', p_phone: '', p_party_size: 2, p_slot: slot })).data
    expect((await g.rpc('reservation_token', { p_reservation: id })).data).toBeNull() // not seated yet
    const seat = await waiter.rpc('staff_resolve_reservation', { p_reservation: id, p_seat: true })
    expect(seat.error).toBeNull()
    const token = (await g.rpc('reservation_token', { p_reservation: id })).data
    expect(token).toBeTruthy()
    const view = await g.rpc('resolve_table', { p_token: token })
    expect(view.data.guest_status).toBe('approved')
    await reset()
  })

  it('an occupied table is not promised for a slot soon, but is for a slot far enough ahead', async () => {
    for (const t of tables) await waiter.rpc('staff_seat_table', { p_table: t.id, p_party_size: 2 })
    const g = await G(0)
    const soon = await g.rpc('create_reservation', { p_branch: BRANCH, p_name: 'Soon', p_phone: '', p_party_size: 2, p_slot: new Date(Date.now() + 30 * 60_000).toISOString() })
    expect(soon.error?.message).toContain('no_table_available')
    {
      const later = await g.rpc('create_reservation', { p_branch: BRANCH, p_name: 'Later', p_phone: '', p_party_size: 2, p_slot: new Date(Date.now() + 2 * 3_600_000).toISOString() })
      expect(later.error).toBeNull()
    }
    await reset()
  })
})

describe('a table of three: equal split and calling a waiter', () => {
  it('splits an awkward total exactly, and the call-waiter flow works', async () => {
    const [g1, g2, g3] = [await G(0), await G(1), await G(2)]
    const a = await seatGuest(g1, 'T7', 'Ali')
    const sessionId = a.sessionId
    for (const [g, name] of [[g2, 'Bina'], [g3, 'Chand']] as const) {
      const { data } = await g.rpc('request_session', { p_token: byLabel('T7').token, p_name: name, p_party_size: 1 })
      expect((await g1.rpc('decide_guest', { p_guest: data.guest_id, p_approve: true })).error).toBeNull()
    }
    const rows = [
      [g1, 'Plain Naan'], // 80
      [g2, 'Roti'], // 40
      [g3, 'Soft Drink'], // 150  -> subtotal 270, tax 14, 284 does not divide by 3
    ] as const
    for (const [g, name] of rows) {
      const view = await g.rpc('resolve_table', { p_token: byLabel('T7').token })
      const ins = await g.from('cart_items').insert({ session_id: sessionId, guest_id: view.data.guest_id, menu_item_id: dish[name].id, qty: 1 })
      expect(ins.error).toBeNull()
    }
    expect((await g1.rpc('place_order', { p_session: sessionId })).error).toBeNull()

    // calling a waiter
    const call = await g2.rpc('call_waiter', { p_session: sessionId, p_reason: 'water' })
    expect(call.error).toBeNull()
    const dup = await g3.rpc('call_waiter', { p_session: sessionId, p_reason: 'water' })
    expect(dup.data).toBe(call.data) // the same open call, not a second row
    const stranger = await G(3)
    expect((await stranger.rpc('call_waiter', { p_session: sessionId, p_reason: 'help' })).error?.message).toContain('session_not_open')
    expect((await g2.rpc('staff_ack_call', { p_call: call.data })).error?.message).toContain('not_staff')
    expect((await g2.rpc('call_waiter', { p_session: sessionId, p_reason: 'not-a-reason' })).error).not.toBeNull()
    expect((await waiter.rpc('staff_ack_call', { p_call: call.data })).error).toBeNull()
    const { data: calls } = await g1.from('waiter_calls').select('status').eq('session_id', sessionId)
    expect(calls!.every((c) => c.status === 'acknowledged')).toBe(true)

    // kitchen
    const { data: items } = await waiter.from('order_items').select('id,order_id').eq('session_id', sessionId)
    for (const i of items!) {
      expect((await waiter.rpc('kitchen_set_item_status', { p_item: i.id, p_status: 'cooking' })).error).toBeNull()
      expect((await waiter.rpc('kitchen_set_item_status', { p_item: i.id, p_status: 'ready' })).error).toBeNull()
    }
    expect((await waiter.rpc('kitchen_serve_order', { p_order: items![0].order_id })).error).toBeNull()

    // bill
    expect((await g1.rpc('request_bill', { p_session: sessionId })).error).toBeNull()
    expect((await g3.rpc('set_bill_split', { p_session: sessionId, p_mode: 'equal', p_tip_percent: 10 })).error).toBeNull()
    const { data: bill } = await g1.from('bills').select('subtotal,tax,tip,total,split_mode').eq('session_id', sessionId).single()
    expect(bill).toMatchObject({ subtotal: 270, tax: 14, tip: 27, total: 311, split_mode: 'equal' })
    const { data: shares } = await g1.from('bill_shares').select('id,amount,tip').eq('session_id', sessionId)
    expect(shares).toHaveLength(3)
    expect(shares!.reduce((n, s) => n + s.amount + s.tip, 0)).toBe(311) // not a rupee lost or invented
    const totals = shares!.map((s) => s.amount + s.tip)
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(2)

    // invalid choices are refused
    expect((await g1.rpc('set_bill_split', { p_session: sessionId, p_mode: 'by_guest', p_tip_percent: 99 })).error?.message).toContain('invalid_split')
    expect((await g1.rpc('pay_share', { p_share: shares![0].id, p_method: 'bitcoin' })).error?.message).toContain('invalid_method')

    for (const [i, s] of shares!.entries()) {
      expect((await [g1, g2, g3][i].rpc('pay_share', { p_share: s.id, p_method: 'cash' })).error).toBeNull()
    }
    expect(await tableState('T7')).toBe('paid_dirty')
    await reset()
  })
})

describe('session expiry', () => {
  it('after a session expires nobody at the table can order, call, or add to the cart', async () => {
    // make sessions last one minute, restoring the real setting afterwards
    const short = { ...originalSettings, session_hours: 0.01 }
    expect((await owner.from('branches').update({ settings: short }).eq('id', BRANCH).select()).data).toHaveLength(1)
    try {
      const g = await G(0)
      const { sessionId, guestId } = await seatGuest(g, 'T9', 'Quick')
      const ok = await g.from('cart_items').insert({ session_id: sessionId, guest_id: guestId, menu_item_id: dish['Roti'].id, qty: 1 })
      expect(ok.error).toBeNull()
      expect((await g.rpc('call_waiter', { p_session: sessionId, p_reason: 'help' })).error).toBeNull()

      await new Promise((r) => setTimeout(r, 63_000))

      const view = await g.rpc('resolve_table', { p_token: byLabel('T9').token })
      expect(view.data.session_status).toBe('expired')
      const add = await g.from('cart_items').insert({ session_id: sessionId, guest_id: guestId, menu_item_id: dish['Roti'].id, qty: 1 })
      expect(add.error).not.toBeNull()
      expect((await g.rpc('place_order', { p_session: sessionId })).error?.message).toContain('session_not_open')
      expect((await g.rpc('call_waiter', { p_session: sessionId, p_reason: 'water' })).error?.message).toContain('session_not_open')
      // staff can still close the table
      expect((await waiter.rpc('staff_close_table', { p_table: byLabel('T9').id })).error).toBeNull()
      expect(await tableState('T9')).toBe('free')
    } finally {
      await owner.from('branches').update({ settings: originalSettings }).eq('id', BRANCH)
    }
  }, 120_000)
})
