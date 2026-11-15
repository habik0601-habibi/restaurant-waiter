/**
 * Kitchen simulation: first come, first served vs the optimised scheduler.
 *
 *   npm run simulate            -> prints a markdown table
 *   npm run simulate -- --json  -> prints raw numbers
 *
 * A simulated evening: orders arrive at random (Poisson), each with a random
 * mix of dishes. Real prep times differ from the menu's estimate by a random
 * factor, so dishes run early and late and the planner has to re-plan, exactly
 * as it does in production. Both planners face the SAME orders and the SAME
 * random prep times. Everything is seeded, so the numbers are reproducible.
 */
import {
  assertFeasible,
  planFcfs,
  planOptimised,
  type Plan,
  type SchedInput,
  type SchedItem,
} from '../src/lib/scheduler/scheduler.ts'

// ---- the sample kitchen (same stations and prep times as the seed data) ----
const STATIONS = [
  { id: 'grill', capacity: 4 },
  { id: 'stove', capacity: 3 },
  { id: 'fryer', capacity: 2 },
  { id: 'cold', capacity: 3 },
]

type Dish = { name: string; station: string; prep: number }
const MAINS: Dish[] = [
  { name: 'Chicken Tikka', station: 'grill', prep: 18 },
  { name: 'Seekh Kebab', station: 'grill', prep: 14 },
  { name: 'Malai Boti', station: 'grill', prep: 16 },
  { name: 'Beef Bihari Kebab', station: 'grill', prep: 20 },
  { name: 'Chicken Karahi', station: 'stove', prep: 22 },
  { name: 'Mutton Karahi', station: 'stove', prep: 30 },
  { name: 'Chicken Handi', station: 'stove', prep: 20 },
  { name: 'Daal Makhni', station: 'stove', prep: 10 },
  { name: 'Chicken Biryani', station: 'stove', prep: 8 },
  { name: 'Beef Nihari', station: 'stove', prep: 8 },
]
const STARTERS: Dish[] = [
  { name: 'Chicken Samosa', station: 'fryer', prep: 6 },
  { name: 'Vegetable Pakora', station: 'fryer', prep: 7 },
  { name: 'Fish Fingers', station: 'fryer', prep: 9 },
  { name: 'Dahi Bhalla', station: 'cold', prep: 3 },
]
const BREADS: Dish[] = [
  { name: 'Plain Naan', station: 'grill', prep: 4 },
  { name: 'Garlic Naan', station: 'grill', prep: 5 },
  { name: 'Roti', station: 'grill', prep: 3 },
]
const DRINKS: Dish[] = [
  { name: 'Mint Margarita', station: 'cold', prep: 3 },
  { name: 'Sweet Lassi', station: 'cold', prep: 3 },
  { name: 'Soft Drink', station: 'cold', prep: 1 },
  { name: 'Fresh Lime', station: 'cold', prep: 2 },
]

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface SimItem {
  id: string
  orderId: string
  station: string
  prep: number // what the menu says
  actual: number // what it really takes this time
}
interface SimOrder {
  id: string
  placedAt: number
  items: SimItem[]
}

/** One evening of orders. */
function generate(seed: number, ordersPerHour: number, minutes: number, noise: number): SimOrder[] {
  const r = rng(seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
  const orders: SimOrder[] = []
  let t = 0
  for (;;) {
    t += (-Math.log(1 - r()) * 60) / ordersPerHour
    if (t > minutes) break
    const id = `o${orders.length}`
    const party = 1 + Math.floor(r() * 4)
    const dishes: Dish[] = []
    const mains = Math.max(1, Math.round(party * (0.6 + r() * 0.4)))
    for (let i = 0; i < mains; i++) dishes.push(pick(MAINS))
    for (let i = 0; i < party; i++) if (r() < 0.8) dishes.push(pick(BREADS))
    for (let i = 0; i < party; i++) if (r() < 0.7) dishes.push(pick(DRINKS))
    if (r() < 0.45) dishes.push(pick(STARTERS))
    orders.push({
      id,
      placedAt: t,
      items: dishes.map((d, i) => ({
        id: `${id}.${i}`,
        orderId: id,
        station: d.station,
        prep: d.prep,
        actual: Math.max(0.5, d.prep * Math.exp(noise * normal())),
      })),
    })
  }
  return orders
}

interface Metrics {
  orders: number
  avgWait: number
  p95Wait: number
  maxWait: number
  avgSpread: number
  p95Spread: number
  avgSitting: number
}

const TICK = 0.25

/**
 * Runs the kitchen. The planner only decides WHEN to start each dish; the
 * kitchen obeys: a dish starts once the plan says so and a slot is really
 * free. The plan is recomputed whenever something changes: an order arrives,
 * a dish finishes, or a dish is still cooking past its expected end.
 */
function simulate(orders: SimOrder[], planner: (i: SchedInput) => Plan, check: boolean): Metrics {
  const placedAt = new Map(orders.map((o) => [o.id, o.placedAt]))
  const state = new Map<string, { item: SimItem; status: 'queued' | 'cooking' | 'ready'; startedAt?: number; readyAt?: number }>()
  const arrived: SimOrder[] = []
  let next = 0
  let plan: Plan | null = null
  let dirty = false

  for (let t = 0; ; t += TICK) {
    while (next < orders.length && orders[next].placedAt <= t) {
      const o = orders[next++]
      arrived.push(o)
      for (const item of o.items) state.set(item.id, { item, status: 'queued' })
      dirty = true
    }
    for (const s of state.values()) {
      if (s.status === 'cooking' && s.startedAt! + s.item.actual <= t) {
        s.status = 'ready'
        s.readyAt = s.startedAt! + s.item.actual
        dirty = true
      } else if (s.status === 'cooking' && s.startedAt! + s.item.prep < t) {
        dirty = true // running late
      }
    }
    const open = arrived.filter((o) => o.items.some((i) => state.get(i.id)!.status !== 'ready'))
    if (open.length === 0 && next >= orders.length) break

    if (dirty) {
      const items: SchedItem[] = []
      for (const o of open) {
        for (const i of o.items) {
          const s = state.get(i.id)!
          items.push({ id: i.id, orderId: o.id, stationId: i.station, duration: i.prep, status: s.status, startedAt: s.startedAt, readyAt: s.readyAt })
        }
      }
      const input: SchedInput = { now: t, stations: STATIONS, orders: open.map((o) => ({ id: o.id, placedAt: o.placedAt })), items }
      plan = planner(input)
      if (check) assertFeasible(input, plan)
      dirty = false
    }

    if (plan) {
      const busy = new Map<string, number>()
      for (const s of state.values()) if (s.status === 'cooking') busy.set(s.item.station, (busy.get(s.item.station) ?? 0) + 1)
      const due = [...state.values()]
        .filter((s) => s.status === 'queued' && plan!.items[s.item.id] && plan!.items[s.item.id].start <= t + 1e-9)
        .sort((a, b) => plan!.items[a.item.id].start - plan!.items[b.item.id].start)
      for (const s of due) {
        const cap = STATIONS.find((x) => x.id === s.item.station)!.capacity
        const used = busy.get(s.item.station) ?? 0
        if (used >= cap) continue
        s.status = 'cooking'
        s.startedAt = t
        busy.set(s.item.station, used + 1)
      }
    }
    if (t > 24 * 60) throw new Error('simulation did not finish')
  }

  const waits: number[] = []
  const spreads: number[] = []
  const sitting: number[] = []
  for (const o of orders) {
    const ends = o.items.map((i) => state.get(i.id)!.readyAt!)
    const last = Math.max(...ends)
    waits.push(last - placedAt.get(o.id)!)
    spreads.push(last - Math.min(...ends))
    for (const e of ends) sitting.push(last - e)
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const pct = (xs: number[], p: number) => {
    const s = xs.slice().sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
  }
  return {
    orders: orders.length,
    avgWait: mean(waits),
    p95Wait: pct(waits, 0.95),
    maxWait: Math.max(...waits),
    avgSpread: mean(spreads),
    p95Spread: pct(spreads, 0.95),
    avgSitting: mean(sitting),
  }
}

// ---------------------------------------------------------------- experiment
const SCENARIOS = [
  { name: 'Quiet (5 orders/h)', perHour: 5 },
  { name: 'Normal (8 orders/h)', perHour: 8 },
  { name: 'Rush (11 orders/h)', perHour: 11 },
]
const SEEDS = Number(process.env.SEEDS ?? 20)
const MINUTES = 180
const NOISE = 0.15 // real prep time = estimate x lognormal(sigma 0.15)

const PLANNERS: { name: string; fn: (i: SchedInput) => Plan }[] = [
  { name: 'FCFS (baseline)', fn: (i) => planFcfs(i) },
  { name: 'Optimised', fn: (i) => planOptimised(i) },
  { name: 'Optimised, throughput mode', fn: (i) => planOptimised(i, { guardBusyStations: true }) },
  ...(process.env.ABLATION
    ? [
        { name: 'no buffer', fn: (i: SchedInput) => planOptimised(i, { buffer: 0 }) },
        { name: 'no swaps', fn: (i: SchedInput) => planOptimised(i, { improve: false }) },
      ]
    : []),
]

const avg = (ms: Metrics[], k: keyof Metrics) => ms.reduce((a, m) => a + m[k], 0) / ms.length
const rows: { scenario: string; planner: string; m: Record<keyof Metrics, number> }[] = []

for (const sc of SCENARIOS) {
  for (const pl of PLANNERS) {
    const runs: Metrics[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
      runs.push(simulate(generate(seed, sc.perHour, MINUTES, NOISE), pl.fn, true))
    }
    rows.push({
      scenario: sc.name,
      planner: pl.name,
      m: {
        orders: avg(runs, 'orders'),
        avgWait: avg(runs, 'avgWait'),
        p95Wait: avg(runs, 'p95Wait'),
        maxWait: Math.max(...runs.map((r) => r.maxWait)),
        avgSpread: avg(runs, 'avgSpread'),
        p95Spread: avg(runs, 'p95Spread'),
        avgSitting: avg(runs, 'avgSitting'),
      },
    })
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const f = (n: number) => n.toFixed(1)
  console.log(`Simulated ${SEEDS} evenings of ${MINUTES} minutes per scenario. Prep-time noise sigma = ${NOISE}. All times in minutes.\n`)
  console.log('| Scenario | Planner | Orders | Avg wait | p95 wait | Worst wait | Avg finish spread | p95 spread | Avg dish sitting |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    console.log(
      `| ${r.scenario} | ${r.planner} | ${f(r.m.orders)} | ${f(r.m.avgWait)} | ${f(r.m.p95Wait)} | ${f(r.m.maxWait)} | ${f(r.m.avgSpread)} | ${f(r.m.p95Spread)} | ${f(r.m.avgSitting)} |`,
    )
  }
  console.log('\nWait = order placed until its last dish is ready. Finish spread = first dish ready until last dish ready.')
  console.log('Dish sitting = how long a finished dish waits for the rest of its order, averaged over dishes.')
}
