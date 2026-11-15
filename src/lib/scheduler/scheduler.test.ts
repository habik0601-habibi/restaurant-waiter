import { describe, expect, it } from 'vitest'
import {
  assertFeasible,
  planFcfs,
  planOptimised,
  type SchedInput,
  type SchedItem,
  type SchedOrder,
} from './scheduler'

const stations = [
  { id: 'grill', capacity: 2 },
  { id: 'stove', capacity: 1 },
  { id: 'cold', capacity: 2 },
]

let seq = 0
function item(orderId: string, stationId: string, duration: number, extra: Partial<SchedItem> = {}): SchedItem {
  return { id: `i${++seq}`, orderId, stationId, duration, status: 'queued', ...extra }
}

function input(orders: SchedOrder[], items: SchedItem[], now = 0): SchedInput {
  return { now, stations, orders, items }
}

/** small deterministic random generator */
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

function randomInput(seed: number, nOrders: number): SchedInput {
  const r = rng(seed)
  const orders: SchedOrder[] = []
  const items: SchedItem[] = []
  for (let o = 0; o < nOrders; o++) {
    const id = `o${o}`
    orders.push({ id, placedAt: -Math.floor(r() * 20) })
    const n = 1 + Math.floor(r() * 5)
    for (let k = 0; k < n; k++) {
      const st = stations[Math.floor(r() * stations.length)]
      items.push(item(id, st.id, 2 + Math.floor(r() * 25)))
    }
  }
  return input(orders, items)
}

describe('baseline: first come, first served', () => {
  it('starts every dish as soon as its station is free', () => {
    const a = item('A', 'stove', 20)
    const b = item('A', 'cold', 3)
    const plan = planFcfs(input([{ id: 'A', placedAt: 0 }], [a, b]))
    expect(plan.items[a.id].start).toBe(0)
    expect(plan.items[b.id].start).toBe(0)
    // the drink is ready 17 minutes before the main: this is the problem
    expect(plan.orders.A.spread).toBe(17)
  })

  it('queues dishes behind a full station in arrival order', () => {
    const a = item('A', 'stove', 10)
    const b = item('B', 'stove', 5)
    const plan = planFcfs(input([{ id: 'A', placedAt: 0 }, { id: 'B', placedAt: 1 }], [b, a]))
    expect(plan.items[a.id].start).toBe(0)
    expect(plan.items[b.id].start).toBe(10)
  })
})

describe('optimised: dishes of one order finish together', () => {
  it('delays the short dish so both land at the same time', () => {
    const a = item('A', 'stove', 20)
    const b = item('A', 'cold', 3)
    const plan = planOptimised(input([{ id: 'A', placedAt: 0 }], [a, b]), { buffer: 0 })
    expect(plan.items[a.id].start).toBe(0)
    expect(plan.items[b.id].start).toBe(17)
    expect(plan.orders.A.spread).toBe(0)
    expect(plan.orders.A.readyAt).toBe(20)
  })

  it('does not finish the order any later than first come, first served would', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const inp = randomInput(seed, 1)
      const fcfs = planFcfs(inp)
      const opt = planOptimised(inp)
      expect(opt.orders.o0.readyAt).toBeLessThanOrEqual(fcfs.orders.o0.readyAt + 1e-6)
    }
  })

  it('never plans ANY order later than first come, first served, with many orders competing', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const inp = randomInput(seed, 2 + (seed % 9))
      const fcfs = planFcfs(inp)
      const guarded = planOptimised(inp, { improve: false, guardBusyStations: true })
      assertFeasible(inp, guarded)
      for (const o of Object.values(guarded.orders)) {
        expect(o.readyAt).toBeLessThanOrEqual(fcfs.orders[o.id].readyAt + 1e-6)
      }
      const opt = planOptimised(inp, { improve: false })
      let fcfsSpread = 0
      let optSpread = 0
      for (const o of Object.values(opt.orders)) {
        expect(o.readyAt).toBeLessThanOrEqual(fcfs.orders[o.id].readyAt + 1e-6)
        fcfsSpread += fcfs.orders[o.id].spread
        optSpread += o.spread
      }
      expect(optSpread).toBeLessThanOrEqual(fcfsSpread + 1e-6)
    }
  })

  it('aims held dishes slightly early when a safety buffer is set', () => {
    const a = item('A', 'stove', 20)
    const b = item('A', 'cold', 4)
    const plan = planOptimised(input([{ id: 'A', placedAt: 0 }], [a, b]), { buffer: 0.25 })
    // the 4-minute dish is aimed to finish 1 minute (25% of 4) before the main
    expect(plan.items[b.id].end).toBe(19)
    expect(plan.items[a.id]).toMatchObject({ start: 0, end: 20 }) // the critical dish cannot be moved earlier
    expect(plan.orders.A.readyAt).toBe(20)
  })

  it('throughput mode: does not hold a dish back on a station where other dishes are waiting', () => {
    // one-slot stove. A: 20 min grill + 5 min stove. B: 30 min stove.
    // Holding A's stove dish until minute 15 would leave the stove idle while B waits.
    const a1 = item('A', 'grill', 20)
    const a2 = item('A', 'stove', 5)
    const b1 = item('B', 'stove', 30)
    const inp = input([{ id: 'A', placedAt: 0 }, { id: 'B', placedAt: 1 }], [a1, a2, b1])
    const guarded = planOptimised(inp, { buffer: 0, improve: false, guardBusyStations: true })
    expect(guarded.items[a2.id].start).toBe(0)
    expect(guarded.items[b1.id].start).toBe(5)
    // default mode holds A's stove dish to land with the grill dish and fits B around it
    const unguarded = planOptimised(inp, { buffer: 0, improve: false })
    expect(unguarded.orders.B.readyAt).toBeLessThanOrEqual(guarded.orders.B.readyAt)
    expect(unguarded.orders.A.spread).toBeLessThanOrEqual(guarded.orders.A.spread)
  })

  it('accepts unavoidable spread when one station is the bottleneck', () => {
    // two 10-minute dishes on a one-slot stove cannot finish together
    const a = item('A', 'stove', 10)
    const b = item('A', 'stove', 10)
    const plan = planOptimised(input([{ id: 'A', placedAt: 0 }], [a, b]))
    expect(plan.orders.A.readyAt).toBe(20)
    expect(plan.orders.A.spread).toBe(10)
  })
})

describe('station capacity', () => {
  it('is never exceeded, for either planner, on random kitchens', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const inp = randomInput(seed, 2 + (seed % 9))
      assertFeasible(inp, planFcfs(inp))
      assertFeasible(inp, planOptimised(inp))
    }
  })

  it('uses a gap in front of a late reservation instead of waiting behind it', () => {
    // A needs the stove only for its last 5 minutes (T = 20). B is newer and
    // needs 10 stove minutes: it fits in the gap before A's reservation.
    const a1 = item('A', 'grill', 20)
    const a2 = item('A', 'stove', 5)
    const b1 = item('B', 'stove', 10)
    const plan = planOptimised(input([{ id: 'A', placedAt: 0 }, { id: 'B', placedAt: 1 }], [a1, a2, b1]), { buffer: 0 })
    expect(plan.items[a2.id].start).toBe(15)
    expect(plan.items[b1.id].start).toBe(0)
    expect(plan.orders.B.readyAt).toBe(10)
  })
})

describe('no starvation', () => {
  it('an old order is delayed by at most maxSlip, however many newer orders arrive', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed)
      const oldItems = [item('OLD', 'stove', 12), item('OLD', 'grill', 15), item('OLD', 'cold', 2)]
      const alone = planOptimised(input([{ id: 'OLD', placedAt: -10 }], oldItems))
      const orders: SchedOrder[] = [{ id: 'OLD', placedAt: -10 }]
      const items = [...oldItems]
      for (let n = 0; n < 12; n++) {
        orders.push({ id: `N${n}`, placedAt: -5 + n * 0.3 })
        items.push(item(`N${n}`, r() < 0.5 ? 'stove' : 'grill', 1 + Math.floor(r() * 4)))
      }
      const crowded = planOptimised(input(orders, items), { maxSlip: 4 })
      expect(crowded.orders.OLD.readyAt).toBeLessThanOrEqual(alone.orders.OLD.readyAt + 4 + 1e-6)
    }
  })

  it('with maxSlip 0 nobody is ever moved behind a newer order', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const inp = randomInput(seed, 6)
      const strict = planOptimised(inp, { improve: false })
      const bounded = planOptimised(inp, { maxSlip: 0 })
      for (const o of Object.values(bounded.orders)) {
        expect(o.readyAt).toBeLessThanOrEqual(strict.orders[o.id].readyAt + 1e-6)
      }
    }
  })

  it('lets a small order jump a big one only when the total cost drops', () => {
    // BIG: four 10-minute kebabs on a 2-slot grill. SMALL: one 2-minute naan.
    const big = [0, 1, 2, 3].map(() => item('BIG', 'grill', 10))
    const small = item('SMALL', 'grill', 2)
    const inp = input([{ id: 'BIG', placedAt: 0 }, { id: 'SMALL', placedAt: 0.5 }], [...big, small])
    const strict = planOptimised(inp, { improve: false })
    const improved = planOptimised(inp)
    expect(improved.cost).toBeLessThanOrEqual(strict.cost)
    expect(improved.orders.SMALL.readyAt).toBeLessThan(strict.orders.SMALL.readyAt)
    expect(improved.orders.BIG.readyAt).toBeLessThanOrEqual(strict.orders.BIG.readyAt + 4)
  })
})

describe('re-planning', () => {
  it('never moves a dish that is already cooking', () => {
    const a = item('A', 'stove', 20, { status: 'cooking', startedAt: 0 })
    const b = item('A', 'cold', 3)
    const plan = planOptimised(input([{ id: 'A', placedAt: 0 }], [a, b], 5), { buffer: 0 })
    expect(plan.items[a.id]).toMatchObject({ start: 0, end: 20, fixed: true })
    expect(plan.items[b.id].start).toBe(17)
  })

  it('pushes the rest of the order back when a cooking dish runs late', () => {
    // the karahi should have finished at t=20; at t=24 it is still on the stove
    const a = item('A', 'stove', 20, { status: 'cooking', startedAt: 0 })
    const b = item('A', 'cold', 3)
    const plan = planOptimised(input([{ id: 'A', placedAt: 0 }], [a, b], 24), { overrun: 2 })
    expect(plan.items[a.id].end).toBe(26)
    expect(plan.items[b.id].end).toBe(27) // cannot start before now=24
    expect(plan.orders.A.readyAt).toBe(27)
  })

  it('a late dish also delays the next order on the same station', () => {
    const a = item('A', 'stove', 10, { status: 'cooking', startedAt: 0 })
    const b = item('B', 'stove', 5)
    const onTime = planOptimised(input([{ id: 'A', placedAt: 0 }, { id: 'B', placedAt: 1 }], [a, b], 5))
    const late = planOptimised(input([{ id: 'A', placedAt: 0 }, { id: 'B', placedAt: 1 }], [a, b], 14), { overrun: 2 })
    expect(onTime.items[b.id].start).toBe(10)
    expect(late.items[b.id].start).toBe(16)
  })

  it('finishes the rest as soon as possible when part of the order is already ready', () => {
    const a = item('A', 'cold', 3, { status: 'ready', readyAt: 4 })
    const b = item('A', 'stove', 10)
    const plan = planOptimised(input([{ id: 'A', placedAt: 0 }], [a, b], 6))
    expect(plan.items[b.id].start).toBe(6)
    expect(plan.orders.A.readyAt).toBe(16)
    expect(plan.orders.A.spread).toBe(12)
  })

  it('re-plans when a new order arrives without disturbing what was promised', () => {
    const a = [item('A', 'stove', 20), item('A', 'cold', 3)]
    const before = planOptimised(input([{ id: 'A', placedAt: 0 }], a, 0))
    const b = [item('B', 'stove', 8), item('B', 'cold', 2)]
    const after = planOptimised(input([{ id: 'A', placedAt: 0 }, { id: 'B', placedAt: 2 }], [...a, ...b], 2))
    expect(after.orders.A.readyAt).toBeLessThanOrEqual(before.orders.A.readyAt + 4)
    expect(after.orders.B).toBeDefined()
    assertFeasible(input([{ id: 'A', placedAt: 0 }, { id: 'B', placedAt: 2 }], [...a, ...b], 2), after)
  })
})

describe('input validation and edge cases', () => {
  it('returns an empty plan for an empty kitchen', () => {
    const plan = planOptimised(input([], []))
    expect(plan.items).toEqual({})
    expect(plan.orders).toEqual({})
    expect(plan.cost).toBe(0)
  })

  it('rejects items that point at unknown stations or orders', () => {
    expect(() => planOptimised(input([{ id: 'A', placedAt: 0 }], [item('A', 'nowhere', 5)]))).toThrow(/unknown station/)
    expect(() => planOptimised(input([], [item('ghost', 'stove', 5)]))).toThrow(/unknown order/)
  })

  it('is deterministic: same input, same plan', () => {
    const inp = randomInput(7, 8)
    expect(planOptimised(inp)).toEqual(planOptimised(inp))
  })

  it('copes when staff have already put more on a station than its capacity', () => {
    const cooking = [0, 1].map(() => item('A', 'stove', 10, { status: 'cooking', startedAt: 0 }))
    const queued = item('B', 'stove', 5)
    const inp = input([{ id: 'A', placedAt: 0 }, { id: 'B', placedAt: 1 }], [...cooking, queued], 2)
    const plan = planOptimised(inp)
    assertFeasible(inp, plan)
    expect(plan.items[queued.id].start).toBe(10)
  })
})
