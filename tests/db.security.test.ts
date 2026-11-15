/**
 * Integration tests against the REAL Supabase database (npm run test:db).
 * They act exactly like browsers would: only the public (publishable) key,
 * staff logins, and anonymous guest sign-ins. Nothing here has admin rights,
 * so if a rule can be bypassed, one of these tests can bypass it.
 *
 * They use table T12 of the seeded branch and leave it free afterwards.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TRANSITIONS } from '../src/lib/tableStateMachine'

const URL = process.env.VITE_SUPABASE_URL!
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!
const BRANCH = process.env.VITE_DEFAULT_BRANCH_ID!

const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

async function staff(email: string, password: string): Promise<SupabaseClient> {
  const c = client()
  const { error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`staff login failed for ${email}: ${error.message}`)
  return c
}

async function guest(): Promise<SupabaseClient> {
  const c = client()
  const { error } = await c.auth.signInAnonymously()
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`)
  return c
}

let waiter: SupabaseClient
let owner: SupabaseClient
let alice: SupabaseClient // first guest at the table
let bilal: SupabaseClient // friend who joins later
let stranger: SupabaseClient // someone at home with a photo of the QR code
let tableId: string
let token: string
let sessionId: string
let aliceGuestId: string
let bilalGuestId: string
let menu: { id: string; name: string; price: number }[]

async function tableState(): Promise<string> {
  const { data } = await waiter.from('tables').select('state').eq('id', tableId).single()
  return data!.state
}

/** Put T12 back to free with no live session, whatever a previous run left behind. */
async function resetTable() {
  await waiter.rpc('staff_close_table', { p_table: tableId }) // ignore "no_live_session"
  if ((await tableState()) === 'paid_dirty') await waiter.rpc('staff_clear_table', { p_table: tableId })
  // an offer may have been made to a waitlist entry: not relevant here
}

beforeAll(async () => {
  waiter = await staff(process.env.TEST_WAITER_EMAIL!, process.env.TEST_WAITER_PASSWORD!)
  owner = await staff(process.env.TEST_OWNER_EMAIL!, process.env.TEST_OWNER_PASSWORD!)
  alice = await guest()
  bilal = await guest()
  stranger = await guest()

  const { data: tokens, error } = await waiter.rpc('staff_table_tokens', { p_branch: BRANCH })
  if (error) throw error
  const t12 = tokens.find((t: { label: string }) => t.label === 'T12')
  tableId = t12.table_id
  token = t12.token
  await resetTable()
  expect(await tableState()).toBe('free')

  const { data: items } = await alice.from('menu_items').select('id,name,price').in('name', ['Plain Naan', 'Daal Makhni', 'Soft Drink'])
  menu = items!
  expect(menu).toHaveLength(3)
})

afterAll(async () => {
  if (waiter && tableId) await resetTable()
})

const dish = (name: string) => menu.find((m) => m.name === name)!

describe('1. the QR token', () => {
  it('a valid token resolves to the table', async () => {
    const { data, error } = await stranger.rpc('resolve_table', { p_token: token })
    expect(error).toBeNull()
    expect(data.label).toBe('T12')
    expect(data.session_id).toBeNull()
  })

  it('a token with a changed signature is rejected', async () => {
    const forged = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    const { error } = await stranger.rpc('resolve_table', { p_token: forged })
    expect(error?.message).toContain('invalid_token')
  })

  it('a signature cannot be reused for a different table', async () => {
    const { data: tokens } = await waiter.rpc('staff_table_tokens', { p_branch: BRANCH })
    const other = tokens.find((t: { label: string }) => t.label === 'T11').token as string
    const mixed = [other.split('.')[0], token.split('.')[1], token.split('.')[2]].join('.')
    const { error } = await stranger.rpc('resolve_table', { p_token: mixed })
    expect(error?.message).toContain('invalid_token')
  })

  it('someone who is not signed in at all gets nothing', async () => {
    const nobody = client()
    const { error } = await nobody.rpc('resolve_table', { p_token: token })
    expect(error).not.toBeNull()
    const { data } = await nobody.from('menu_items').select('id')
    expect(data ?? []).toHaveLength(0)
  })
})

describe('2. scanning does not allow ordering', () => {
  it('a scan only files a pending request', async () => {
    const { data, error } = await alice.rpc('request_session', { p_token: token, p_name: 'Alice', p_party_size: 2 })
    expect(error).toBeNull()
    expect(data.session_status).toBe('pending')
    expect(data.guest_status).toBe('pending')
    sessionId = data.session_id
    aliceGuestId = data.guest_id
    expect(await tableState()).toBe('free')
  })

  it('a pending guest cannot add to the cart or place an order', async () => {
    const ins = await alice.from('cart_items').insert({ session_id: sessionId, guest_id: aliceGuestId, menu_item_id: dish('Plain Naan').id, qty: 1 })
    expect(ins.error).not.toBeNull()
    const order = await alice.rpc('place_order', { p_session: sessionId })
    expect(order.error?.message).toContain('session_not_open')
  })

  it('a guest cannot approve their own request', async () => {
    const r = await alice.rpc('staff_decide_session', { p_session: sessionId, p_approve: true })
    expect(r.error?.message).toContain('not_staff')
    const direct = await alice.from('table_sessions').update({ status: 'open' }).eq('id', sessionId).select()
    expect(direct.error ?? (direct.data ?? []).length === 0).toBeTruthy()
    const { data } = await waiter.from('table_sessions').select('status').eq('id', sessionId).single()
    expect(data!.status).toBe('pending')
  })

  it('staff approve, and the table becomes seated', async () => {
    const { error } = await waiter.rpc('staff_decide_session', { p_session: sessionId, p_approve: true })
    expect(error).toBeNull()
    expect(await tableState()).toBe('seated')
  })
})

describe('3. the shared cart', () => {
  it('an approved guest can add to the cart', async () => {
    const { error } = await alice
      .from('cart_items')
      .insert({ session_id: sessionId, guest_id: aliceGuestId, menu_item_id: dish('Daal Makhni').id, qty: 2, notes: 'less butter' })
    expect(error).toBeNull()
  })

  it('a stranger with the QR photo can see and change nothing', async () => {
    const read = await stranger.from('cart_items').select('id').eq('session_id', sessionId)
    expect(read.data).toHaveLength(0)
    const ins = await stranger.from('cart_items').insert({ session_id: sessionId, guest_id: aliceGuestId, menu_item_id: dish('Soft Drink').id, qty: 5 })
    expect(ins.error).not.toBeNull()
    const order = await stranger.rpc('place_order', { p_session: sessionId })
    expect(order.error?.message).toContain('session_not_open')
    const call = await stranger.rpc('call_waiter', { p_session: sessionId, p_reason: 'help' })
    expect(call.error?.message).toContain('session_not_open')
  })

  it('a friend who scans later is pending until someone at the table lets them in', async () => {
    const { data } = await bilal.rpc('request_session', { p_token: token, p_name: 'Bilal', p_party_size: 1 })
    expect(data.session_id).toBe(sessionId)
    expect(data.guest_status).toBe('pending')
    bilalGuestId = data.guest_id
    expect((await bilal.from('cart_items').select('id').eq('session_id', sessionId)).data).toHaveLength(0)

    // the stranger cannot vouch for anyone
    const bad = await stranger.rpc('decide_guest', { p_guest: bilalGuestId, p_approve: true })
    expect(bad.error?.message).toContain('not_allowed')

    const ok = await alice.rpc('decide_guest', { p_guest: bilalGuestId, p_approve: true })
    expect(ok.error).toBeNull()
    expect((await bilal.from('cart_items').select('id').eq('session_id', sessionId)).data).toHaveLength(1)
  })

  it('each guest can change only their own lines', async () => {
    await bilal.from('cart_items').insert({ session_id: sessionId, guest_id: bilalGuestId, menu_item_id: dish('Soft Drink').id, qty: 1 })
    // Bilal tries to delete Alice's line, and to add a line in Alice's name
    const del = await bilal.from('cart_items').delete().eq('guest_id', aliceGuestId).select()
    expect(del.data ?? []).toHaveLength(0)
    const spoof = await bilal.from('cart_items').insert({ session_id: sessionId, guest_id: aliceGuestId, menu_item_id: dish('Soft Drink').id, qty: 9 })
    expect(spoof.error).not.toBeNull()
    const { data } = await alice.from('cart_items').select('id').eq('session_id', sessionId)
    expect(data).toHaveLength(2)
  })
})

describe('4. orders are created only by the database function', () => {
  let orderId: string

  it('a guest cannot insert an order or order item directly', async () => {
    const o = await alice.from('orders').insert({ branch_id: BRANCH, session_id: sessionId, table_id: tableId })
    expect(o.error).not.toBeNull()
    const i = await alice.from('order_items').insert({
      order_id: crypto.randomUUID(), branch_id: BRANCH, session_id: sessionId, name: 'Free food', unit_price: 0, prep_minutes: 1,
    })
    expect(i.error).not.toBeNull()
  })

  it('place_order turns the cart into an order with server-side prices', async () => {
    const { data, error } = await alice.rpc('place_order', { p_session: sessionId })
    expect(error).toBeNull()
    orderId = data
    const { data: items } = await alice.from('order_items').select('name,unit_price,guest_id,notes,status').eq('order_id', orderId)
    expect(items).toHaveLength(3) // 2 x daal (one row per unit) + 1 soft drink
    const daal = items!.filter((i) => i.name === 'Daal Makhni')
    expect(daal).toHaveLength(2)
    expect(daal[0].unit_price).toBe(dish('Daal Makhni').price)
    expect(daal[0].guest_id).toBe(aliceGuestId)
    expect(daal[0].notes).toBe('less butter')
    expect(items!.find((i) => i.name === 'Soft Drink')!.guest_id).toBe(bilalGuestId)
    expect((await alice.from('cart_items').select('id').eq('session_id', sessionId)).data).toHaveLength(0)
    expect(await tableState()).toBe('ordered')
  })

  it('a guest cannot change order items or kitchen status', async () => {
    const upd = await alice.from('order_items').update({ unit_price: 1 }).eq('order_id', orderId).select()
    expect(upd.error ?? (upd.data ?? []).length === 0).toBeTruthy()
    const { data: items } = await alice.from('order_items').select('id').eq('order_id', orderId)
    const r = await alice.rpc('kitchen_set_item_status', { p_item: items![0].id, p_status: 'served' })
    expect(r.error?.message).toContain('not_staff')
  })

  it('the bill cannot be requested while food is still cooking', async () => {
    const r = await alice.rpc('request_bill', { p_session: sessionId })
    expect(r.error?.message).toContain('orders_in_progress')
  })

  it('the kitchen cooks and serves; the table moves to eating', async () => {
    const { data: items } = await waiter.from('order_items').select('id').eq('order_id', orderId)
    const skip = await waiter.rpc('kitchen_set_item_status', { p_item: items![0].id, p_status: 'ready' })
    expect(skip.error?.message).toContain('invalid_item_transition') // queued -> ready is not allowed
    for (const it of items!) {
      for (const status of ['cooking', 'ready']) {
        const { error } = await waiter.rpc('kitchen_set_item_status', { p_item: it.id, p_status: status })
        expect(error).toBeNull()
      }
    }
    expect(await tableState()).toBe('ordered')
    const { error } = await waiter.rpc('kitchen_serve_order', { p_order: orderId })
    expect(error).toBeNull()
    expect(await tableState()).toBe('eating')
  })
})

describe('5. the table state machine is enforced in the database', () => {
  it('the database and the TypeScript module agree on the legal transitions', async () => {
    const { data } = await waiter.from('table_transitions').select('from_state,to_state,event')
    const db = data!.map((t) => `${t.from_state}>${t.to_state}:${t.event}`).sort()
    const ts = TRANSITIONS.map((t) => `${t.from}>${t.to}:${t.event}`).sort()
    expect(db).toEqual(ts)
  })

  it('an illegal transition is refused (eating -> free)', async () => {
    const { error } = await waiter.rpc('staff_clear_table', { p_table: tableId })
    expect(error?.message).toContain('invalid_transition')
    expect(await tableState()).toBe('eating')
  })

  it('even the owner cannot write the state column directly', async () => {
    const r = await owner.from('tables').update({ state: 'free' }).eq('id', tableId).select()
    expect(r.error?.message).toContain('transition_table')
    expect(await tableState()).toBe('eating')
  })

  it('a guest cannot touch tables at all', async () => {
    const read = await alice.from('tables').select('id')
    expect(read.data ?? []).toHaveLength(0)
    const r = await alice.rpc('staff_clear_table', { p_table: tableId })
    expect(r.error?.message).toContain('not_staff')
  })

  it('a seated table cannot be double-booked', async () => {
    const r = await waiter.rpc('staff_seat_table', { p_table: tableId, p_party_size: 2 })
    expect(r.error?.message).toContain('table_not_free')
  })
})

describe('6. bill, split and (simulated) payment', () => {
  it('the bill is split by who ordered what, and the shares add up exactly', async () => {
    const bill = await alice.rpc('request_bill', { p_session: sessionId })
    expect(bill.error).toBeNull()
    expect(await tableState()).toBe('bill_requested')
    const split = await alice.rpc('set_bill_split', { p_session: sessionId, p_mode: 'by_guest', p_tip_percent: 10 })
    expect(split.error).toBeNull()

    const { data: b } = await alice.from('bills').select('subtotal,tax,tip,total,split_mode').eq('session_id', sessionId).single()
    const subtotal = 2 * dish('Daal Makhni').price + dish('Soft Drink').price
    expect(b!.subtotal).toBe(subtotal)
    expect(b!.tax).toBe(Math.round(subtotal * 0.05))
    expect(b!.tip).toBe(Math.round(subtotal * 0.1))
    expect(b!.total).toBe(b!.subtotal + b!.tax + b!.tip)

    const { data: shares } = await alice.from('bill_shares').select('guest_id,amount,tip').eq('session_id', sessionId)
    expect(shares).toHaveLength(2)
    expect(shares!.reduce((s, x) => s + x.amount + x.tip, 0)).toBe(b!.total)
    const mine = shares!.find((s) => s.guest_id === aliceGuestId)!
    const his = shares!.find((s) => s.guest_id === bilalGuestId)!
    expect(mine.amount).toBeGreaterThan(his.amount)
  })

  it('no more ordering once the bill is requested', async () => {
    const ins = await alice.from('cart_items').insert({ session_id: sessionId, guest_id: aliceGuestId, menu_item_id: dish('Plain Naan').id, qty: 1 })
    expect(ins.error).not.toBeNull()
  })

  it('a stranger cannot pay or read the bill', async () => {
    expect((await stranger.from('bills').select('id').eq('session_id', sessionId)).data).toHaveLength(0)
    const { data: shares } = await alice.from('bill_shares').select('id').eq('session_id', sessionId)
    const r = await stranger.rpc('pay_share', { p_share: shares![0].id, p_method: 'cash' })
    expect(r.error?.message).toContain('not_allowed')
  })

  it('paying every share closes the session and marks the table for cleaning', async () => {
    const { data: shares } = await alice.from('bill_shares').select('id,guest_id').eq('session_id', sessionId)
    const first = await alice.rpc('pay_share', { p_share: shares!.find((s) => s.guest_id === aliceGuestId)!.id, p_method: 'card' })
    expect(first.error).toBeNull()
    expect(await tableState()).toBe('bill_requested') // one share still open
    const again = await alice.rpc('pay_share', { p_share: shares!.find((s) => s.guest_id === aliceGuestId)!.id, p_method: 'card' })
    expect(again.error?.message).toContain('already_paid')
    const second = await bilal.rpc('pay_share', { p_share: shares!.find((s) => s.guest_id === bilalGuestId)!.id, p_method: 'cash' })
    expect(second.error).toBeNull()

    expect(await tableState()).toBe('paid_dirty')
    const { data: s } = await waiter.from('table_sessions').select('status').eq('id', sessionId).single()
    expect(s!.status).toBe('closed')
    const { data: pays } = await waiter.from('payments').select('is_simulated,provider').eq('branch_id', BRANCH).order('created_at', { ascending: false }).limit(2)
    expect(pays!.every((p) => p.is_simulated && p.provider === 'simulated')).toBe(true)
  })
})

describe('7. a closed session is dead: the photographed QR code', () => {
  it('the same phones that were approved an hour ago can no longer order', async () => {
    const ins = await alice.from('cart_items').insert({ session_id: sessionId, guest_id: aliceGuestId, menu_item_id: dish('Plain Naan').id, qty: 1 })
    expect(ins.error).not.toBeNull()
    const order = await alice.rpc('place_order', { p_session: sessionId })
    expect(order.error?.message).toContain('session_not_open')
    const call = await alice.rpc('call_waiter', { p_session: sessionId, p_reason: 'water' })
    expect(call.error?.message).toContain('session_not_open')
  })

  it('scanning again only creates a new pending request that staff can refuse', async () => {
    const { data } = await alice.rpc('request_session', { p_token: token, p_name: 'Alice', p_party_size: 2 })
    expect(data.session_status).toBe('pending')
    expect(data.session_id).not.toBe(sessionId)
    const order = await alice.rpc('place_order', { p_session: data.session_id })
    expect(order.error?.message).toContain('session_not_open')
    const deny = await waiter.rpc('staff_decide_session', { p_session: data.session_id, p_approve: false })
    expect(deny.error).toBeNull()
    const after = await alice.rpc('resolve_table', { p_token: token })
    expect(after.data.session_id).toBeNull()
  })

  it('guests can still rate the visit, once each', async () => {
    const r = await alice.rpc('submit_rating', { p_session: sessionId, p_stars: 5, p_comment: 'test run' })
    expect(r.error).toBeNull()
    const bad = await stranger.rpc('submit_rating', { p_session: sessionId, p_stars: 1 })
    expect(bad.error?.message).toContain('not_allowed')
  })

  it('table cleared: back to free', async () => {
    const { error } = await waiter.rpc('staff_clear_table', { p_table: tableId })
    expect(error).toBeNull()
    expect(await tableState()).toBe('free')
  })
})

describe('8. staff-only data stays staff-only', () => {
  it('guests cannot read other tables, staff, payments or the audit log', async () => {
    for (const t of ['tables', 'staff_members', 'payments', 'table_state_events', 'waitlist_entries']) {
      const { data } = await stranger.from(t).select('*').limit(5)
      expect(data ?? [], t).toHaveLength(0)
    }
  })

  it('guests cannot edit the menu; the owner can', async () => {
    const id = dish('Soft Drink').id
    const g = await alice.from('menu_items').update({ price: 1 }).eq('id', id).select()
    expect(g.error ?? (g.data ?? []).length === 0).toBeTruthy()
    const w = await waiter.from('menu_items').update({ price: 1 }).eq('id', id).select()
    expect(w.error ?? (w.data ?? []).length === 0).toBeTruthy() // waiters are not managers
    const o = await owner.from('menu_items').update({ price: dish('Soft Drink').price }).eq('id', id).select()
    expect(o.error).toBeNull()
    expect(o.data).toHaveLength(1)
  })

  it('guests cannot write the kitchen schedule', async () => {
    const r = await alice.rpc('apply_schedule', { p_branch: BRANCH, p_items: [], p_orders: [] })
    expect(r.error?.message).toContain('not_allowed')
  })
})
