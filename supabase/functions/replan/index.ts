// Edge function: re-plan the kitchen for one branch.
//
// Called by the apps after anything that changes the kitchen's workload: an
// order is placed, a dish is started / finished / served, and every 30 seconds
// by the kitchen display (to catch dishes that are running late).
//
// It loads the open dishes, runs the pure scheduler module (scheduler.ts is a
// copy of src/lib/scheduler/scheduler.ts, see scripts/sync-scheduler.mjs) and
// writes each dish's planned start/ready time and each order's estimated
// ready time back through public.apply_schedule().
//
// Any signed-in user (guest or staff) may trigger a re-plan. That is safe: the
// caller supplies nothing but a branch id, and the plan is computed entirely
// from database state with the service role.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { planOptimised, type SchedItem, type SchedOrder } from './scheduler.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false },
    })

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: auth } = await admin.auth.getUser(token)
    if (!auth?.user) return json({ error: 'not_authenticated' }, 401)

    const { branch_id } = await req.json()
    if (typeof branch_id !== 'string') return json({ error: 'branch_id required' }, 400)

    const [stations, items] = await Promise.all([
      admin.from('stations').select('id, capacity').eq('branch_id', branch_id),
      admin
        .from('order_items')
        .select('id, order_id, station_id, prep_minutes, status, started_at, ready_at, planned_start_at, orders!inner(id, placed_at, status)')
        .eq('branch_id', branch_id)
        .eq('is_sample', false)
        .in('status', ['queued', 'cooking', 'ready'])
        .eq('orders.status', 'open'),
    ])
    if (stations.error) throw stations.error
    if (items.error) throw items.error

    // The scheduler works in minutes on a clock where "now" is 0.
    const nowMs = Date.now()
    const toMin = (iso: string) => (Date.parse(iso) - nowMs) / 60000
    const toIso = (min: number) => new Date(Math.round((nowMs + min * 60000) / 1000) * 1000).toISOString()

    const stationIds = new Set((stations.data ?? []).map((s) => s.id))
    const orders = new Map<string, SchedOrder>()
    const schedItems: SchedItem[] = []
    const existingStart = new Map<string, string | null>()
    for (const row of items.data ?? []) {
      if (!row.station_id || !stationIds.has(row.station_id)) continue
      const order = (Array.isArray(row.orders) ? row.orders[0] : row.orders) as { id: string; placed_at: string }
      orders.set(order.id, { id: order.id, placedAt: toMin(order.placed_at) })
      existingStart.set(row.id, row.planned_start_at)
      schedItems.push({
        id: row.id,
        orderId: order.id,
        stationId: row.station_id,
        duration: row.prep_minutes,
        status: row.status,
        startedAt: row.started_at ? toMin(row.started_at) : undefined,
        readyAt: row.ready_at ? toMin(row.ready_at) : undefined,
      })
    }

    const plan = planOptimised({
      now: 0,
      stations: (stations.data ?? []).map((s) => ({ id: s.id, capacity: s.capacity })),
      orders: [...orders.values()],
      items: schedItems,
    })

    const p_items = schedItems
      .filter((it) => it.status !== 'ready')
      .map((it) => {
        const p = plan.items[it.id]
        // A dish that is due now keeps the start time it was first given, so
        // the kitchen display shows how overdue it is instead of a moving target.
        const prev = existingStart.get(it.id)
        const dueNow = it.status === 'queued' && p.start <= 0.05
        const start = dueNow && prev && Date.parse(prev) <= nowMs ? prev : toIso(p.start)
        return { id: it.id, start, ready: toIso(p.end) }
      })
    const p_orders = Object.values(plan.orders).map((o) => ({ id: o.id, ready: toIso(Math.max(o.readyAt, 0)) }))

    const { error } = await admin.rpc('apply_schedule', { p_branch: branch_id, p_items, p_orders })
    if (error) throw error
    return json({ ok: true, orders: p_orders.length, items: p_items.length })
  } catch (e) {
    console.error(e)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
