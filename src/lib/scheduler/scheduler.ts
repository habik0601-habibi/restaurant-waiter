/**
 * Kitchen scheduler — a pure module. No UI, no database, no imports.
 *
 * Problem: every dish has a prep time and a station; every station can cook
 * only `capacity` dishes at once. Decide when each dish should START so that
 *   1. all dishes of one order finish close together (nothing goes cold),
 *   2. no station is over capacity,
 *   3. older orders are never starved by newer ones.
 *
 * All times are plain numbers in MINUTES on one shared clock (the caller
 * picks the origin). See docs/scheduler.md for the full explanation.
 */

export interface StationSpec {
  id: string
  /** dishes this station can cook at the same time */
  capacity: number
}

export interface SchedOrder {
  id: string
  placedAt: number
}

export interface SchedItem {
  id: string
  orderId: string
  stationId: string
  /** expected prep time in minutes */
  duration: number
  status: 'queued' | 'cooking' | 'ready'
  /** required when status is 'cooking' */
  startedAt?: number
  /** required when status is 'ready' */
  readyAt?: number
}

export interface SchedInput {
  now: number
  stations: StationSpec[]
  orders: SchedOrder[]
  items: SchedItem[]
}

export interface PlannedItem {
  id: string
  orderId: string
  stationId: string
  start: number
  end: number
  /** true when the item is already cooking or ready, i.e. not movable */
  fixed: boolean
}

export interface PlannedOrder {
  id: string
  /** when the last dish of the order is expected to be ready */
  readyAt: number
  /** when the first dish is expected to be ready */
  firstReadyAt: number
  /** readyAt - firstReadyAt: how long the first dish waits for the last */
  spread: number
}

export interface Plan {
  items: Record<string, PlannedItem>
  orders: Record<string, PlannedOrder>
  /** objective value of this plan (lower is better) */
  cost: number
}

export interface SchedOptions {
  /** A cooking dish that is past its expected end is assumed to need this many more minutes. */
  overrun?: number
  /** Weight of an order's finish spread against its wait in the objective. */
  spreadWeight?: number
  /** Anti-starvation bound: the most minutes any order may slip, compared with strict oldest-first. */
  maxSlip?: number
  /** Run the improvement pass (adjacent swaps). Off = pure oldest-first just-in-time. */
  improve?: boolean
  /**
   * Safety margin against prep-time noise: a held dish is aimed to finish
   * `buffer x its own duration` before the order's deadline. 0 = exactly on time.
   */
  buffer?: number
  /**
   * Throughput mode (off by default). When a station has dishes waiting for a
   * slot, never leave a slot idle there: as many dishes start immediately as
   * under FCFS, chosen by least slack. Keeps waits at FCFS level but gives up
   * most of the finish-together benefit. See docs/scheduler.md for numbers.
   */
  guardBusyStations?: boolean
}

const DEFAULTS: Required<SchedOptions> = { overrun: 1, spreadWeight: 1, maxSlip: 4, improve: true, buffer: 0.15, guardBusyStations: false }
const EPS = 1e-9

type Interval = [start: number, end: number]

/** Busy intervals of one station, one sorted list per cooking slot. */
class Timeline {
  slots: Interval[][]

  constructor(capacity: number, slots?: Interval[][]) {
    this.slots = slots ?? Array.from({ length: Math.max(1, capacity) }, () => [])
  }

  clone(): Timeline {
    return new Timeline(0, this.slots.map((s) => s.slice()))
  }

  /** Earliest start >= notBefore at which some slot is free for `dur`. */
  earliest(dur: number, notBefore: number): { slot: number; start: number } {
    let best = { slot: 0, start: Infinity }
    this.slots.forEach((busy, slot) => {
      let t = notBefore
      for (const [a, b] of busy) {
        if (t + dur <= a + EPS) break
        if (b > t) t = b
      }
      if (t < best.start - EPS) best = { slot, start: t }
    })
    return best
  }

  /** Latest start >= notBefore such that the dish ends by `endBy`, or null. */
  latest(dur: number, endBy: number, notBefore: number): { slot: number; start: number } | null {
    let best: { slot: number; start: number } | null = null
    this.slots.forEach((busy, slot) => {
      let end = endBy
      let found: number | null = null
      for (let i = busy.length - 1; i >= 0; i--) {
        const [a, b] = busy[i]
        if (a >= end - EPS) continue
        if (b > end + EPS) {
          end = a
          continue
        }
        if (end - dur >= Math.max(b, notBefore) - EPS) {
          found = end - dur
          break
        }
        end = a
      }
      if (found === null && end - dur >= notBefore - EPS) found = end - dur
      if (found !== null && (best === null || found > best.start + EPS)) best = { slot, start: found }
    })
    return best
  }

  reserve(slot: number, start: number, end: number): void {
    const busy = this.slots[slot]
    let i = busy.length
    while (i > 0 && busy[i - 1][0] > start) i--
    busy.splice(i, 0, [start, end])
  }

  /** Reserve an interval that is already happening, adding a slot if the station is over capacity. */
  reserveFixed(start: number, end: number): void {
    for (let slot = 0; slot < this.slots.length; slot++) {
      if (this.slots[slot].every(([a, b]) => end <= a + EPS || start >= b - EPS)) {
        this.reserve(slot, start, end)
        return
      }
    }
    this.slots.push([[start, end]])
  }
}

interface Prepared {
  now: number
  orders: SchedOrder[] // oldest first
  byOrder: Map<string, SchedItem[]>
  capacity: Map<string, number>
  overrun: number
  buffer: number
  guard: boolean
}

function prepare(input: SchedInput, opt: Required<SchedOptions>): Prepared {
  const overrun = opt.overrun
  const byOrder = new Map<string, SchedItem[]>()
  for (const it of input.items) {
    if (it.duration <= 0) throw new Error(`item ${it.id} has a non-positive duration`)
    const list = byOrder.get(it.orderId)
    if (list) list.push(it)
    else byOrder.set(it.orderId, [it])
  }
  const known = new Set(input.orders.map((o) => o.id))
  for (const id of byOrder.keys()) {
    if (!known.has(id)) throw new Error(`item refers to unknown order ${id}`)
  }
  const capacity = new Map(input.stations.map((s) => [s.id, s.capacity]))
  for (const it of input.items) {
    if (!capacity.has(it.stationId)) throw new Error(`item ${it.id} refers to unknown station ${it.stationId}`)
  }
  // stable sort: oldest first, ties keep input order
  const orders = input.orders
    .map((o, i) => ({ o, i }))
    .sort((x, y) => x.o.placedAt - y.o.placedAt || x.i - y.i)
    .map((x) => x.o)
  return { now: input.now, orders, byOrder, capacity, overrun, buffer: opt.buffer, guard: opt.guardBusyStations }
}

/** Expected end of a dish that is already on the heat. */
function cookingEnd(it: SchedItem, now: number, overrun: number): number {
  const start = it.startedAt ?? now
  const planned = start + it.duration
  return planned > now ? planned : now + overrun
}

function freshTimelines(p: Prepared, items: Record<string, PlannedItem>): Map<string, Timeline> {
  const tl = new Map<string, Timeline>()
  for (const [id, cap] of p.capacity) tl.set(id, new Timeline(cap))
  for (const list of p.byOrder.values()) {
    for (const it of list) {
      if (it.status === 'cooking') {
        const start = it.startedAt ?? p.now
        const end = cookingEnd(it, p.now, p.overrun)
        tl.get(it.stationId)!.reserveFixed(start, end)
        items[it.id] = { id: it.id, orderId: it.orderId, stationId: it.stationId, start, end, fixed: true }
      } else if (it.status === 'ready') {
        const end = it.readyAt ?? p.now
        items[it.id] = { id: it.id, orderId: it.orderId, stationId: it.stationId, start: end - it.duration, end, fixed: true }
      }
    }
  }
  return tl
}

function summarise(p: Prepared, items: Record<string, PlannedItem>, spreadWeight: number): Plan {
  const orders: Record<string, PlannedOrder> = {}
  let cost = 0
  for (const o of p.orders) {
    const list = p.byOrder.get(o.id)
    if (!list || list.length === 0) continue
    let first = Infinity
    let last = -Infinity
    for (const it of list) {
      const end = items[it.id].end
      if (end < first) first = end
      if (end > last) last = end
    }
    orders[o.id] = { id: o.id, readyAt: last, firstReadyAt: first, spread: last - first }
    cost += last - o.placedAt + spreadWeight * (last - first)
  }
  return { items, orders, cost }
}

/**
 * Baseline: first come, first served. Orders are taken oldest first and every
 * dish starts the moment its station has a free slot.
 */
export function planFcfs(input: SchedInput, options: SchedOptions = {}): Plan {
  const opt = { ...DEFAULTS, ...options }
  const p = prepare(input, opt)
  const items: Record<string, PlannedItem> = {}
  const tl = freshTimelines(p, items)
  for (const o of p.orders) {
    for (const it of p.byOrder.get(o.id) ?? []) {
      if (it.status !== 'queued') continue
      const line = tl.get(it.stationId)!
      const { slot, start } = line.earliest(it.duration, p.now)
      line.reserve(slot, start, start + it.duration)
      items[it.id] = { id: it.id, orderId: it.orderId, stationId: it.stationId, start, end: start + it.duration, fixed: false }
    }
  }
  return summarise(p, items, opt.spreadWeight)
}

type Placement = { slot: number; start: number }

/** Completion time of every order given placements of its queued dishes. */
function completions(p: Prepared, fixed: Record<string, PlannedItem>, placed: Map<string, Placement>): Map<string, number> {
  const done = new Map<string, number>()
  for (const o of p.orders) {
    let last = -Infinity
    for (const it of p.byOrder.get(o.id) ?? []) {
      if (it.status === 'ready') continue
      const end = it.status === 'cooking' ? fixed[it.id].end : placed.get(it.id)!.start + it.duration
      if (end > last) last = end
    }
    if (last > -Infinity) done.set(o.id, last)
  }
  return done
}

/** Forward pass: take dishes in the given order and start each as early as its station allows. */
function forwardPass(p: Prepared, queue: SchedItem[]): { fixed: Record<string, PlannedItem>; placed: Map<string, Placement> } {
  const fixed: Record<string, PlannedItem> = {}
  const tl = freshTimelines(p, fixed)
  const placed = new Map<string, Placement>()
  for (const it of queue) {
    const line = tl.get(it.stationId)!
    const spot = line.earliest(it.duration, p.now)
    line.reserve(spot.slot, spot.start, spot.start + it.duration)
    placed.set(it.id, spot)
  }
  return { fixed, placed }
}

/**
 * Backward pass ("justification"): keep every order's completion time as a
 * deadline and push each dish as LATE as its station allows without missing
 * it. Dishes with the latest deadline are placed first; among equals the
 * shortest goes last in time, so the long dish is not left to finish early.
 * If a station cannot be packed this way, that station keeps its forward
 * placements, so the result is never worse than the forward pass.
 */
function backwardPass(
  p: Prepared,
  queue: SchedItem[],
  deadline: Map<string, number>,
  forward: Map<string, Placement>,
  final: boolean,
): Map<string, Placement> {
  const fixed: Record<string, PlannedItem> = {}
  const tl = freshTimelines(p, fixed)
  const out = new Map<string, Placement>()
  const byStation = new Map<string, SchedItem[]>()
  for (const it of queue) {
    const list = byStation.get(it.stationId)
    if (list) list.push(it)
    else byStation.set(it.stationId, [it])
  }
  for (const [stationId, list] of byStation) {
    const base = tl.get(stationId)!
    const margin = final ? p.buffer : 0

    // Pack the given dishes as late as possible on a copy of the station.
    const pack = (pinned: SchedItem[], movable: SchedItem[]): Map<string, Placement> | null => {
      const line = base.clone()
      const mine = new Map<string, Placement>()
      for (const it of pinned) {
        const spot = line.earliest(it.duration, p.now)
        if (spot.start + it.duration > deadline.get(it.orderId)! + EPS) return null
        line.reserve(spot.slot, spot.start, spot.start + it.duration)
        mine.set(it.id, spot)
      }
      const sorted = movable
        .map((it, i) => ({ it, i }))
        .sort((a, b) => deadline.get(b.it.orderId)! - deadline.get(a.it.orderId)! || a.it.duration - b.it.duration || a.i - b.i)
      for (const { it } of sorted) {
        const due = deadline.get(it.orderId)!
        const spot =
          (margin > 0 ? line.latest(it.duration, due - margin * it.duration, p.now) : null) ??
          line.latest(it.duration, due, p.now)
        if (!spot) return null
        line.reserve(spot.slot, spot.start, spot.start + it.duration)
        mine.set(it.id, spot)
      }
      return mine
    }

    let result = pack([], list)

    // Busy-station guard (final pass only). If some dish here has to wait for
    // a slot, the station is a bottleneck right now, and an idle slot is lost
    // capacity. The forward pass starts n dishes immediately; keep n starting
    // immediately, but choose the n with the LEAST slack (earliest late start)
    // rather than the n oldest. Dishes with slack to spare are still held.
    if (result && final && p.guard) {
      const startNow = list.filter((it) => forward.get(it.id)!.start <= p.now + EPS).length
      if (startNow > 0 && startNow < list.length) {
        const late = result
        const urgent = list
          .map((it, i) => ({ it, i }))
          .sort((a, b) => late.get(a.it.id)!.start - late.get(b.it.id)!.start || a.i - b.i)
          .map((x) => x.it)
        result = pack(urgent.slice(0, startNow), urgent.slice(startNow)) ?? null
      }
    }
    for (const it of list) out.set(it.id, result ? result.get(it.id)! : forward.get(it.id)!)
  }
  return out
}

/**
 * Builds a plan for one priority sequence of the orders, in up to four passes
 * (forward-backward improvement, a technique from project scheduling):
 *
 *   F1  forward:  orders in priority sequence, every dish as early as
 *                 possible. This is exactly first come, first served and
 *                 gives each order a completion time C.
 *   B1  backward: with C as the deadline, push every dish as late as
 *                 possible. Short dishes now start late and land together
 *                 with the long ones. No order finishes later than in F1.
 *   F2  forward:  take dishes in the order B1 starts them and pull each as
 *                 early as possible again. Dishes that B1 moved out of the
 *                 way free up early capacity, so some orders finish sooner.
 *   B2  backward: justify again against the best completion times found,
 *                 this time with the safety buffer and the busy-station guard.
 *
 * F2 is kept only if no order finishes later than it did after F1, so every
 * order is planned to be ready no later than under FCFS.
 */
function build(p: Prepared, sequence: SchedOrder[], spreadWeight: number): Plan {
  const queue: SchedItem[] = []
  for (const o of sequence) {
    for (const it of p.byOrder.get(o.id) ?? []) if (it.status === 'queued') queue.push(it)
  }

  const f1 = forwardPass(p, queue)
  const c1 = completions(p, f1.fixed, f1.placed)
  const late = backwardPass(p, queue, c1, f1.placed, false)

  const rank = new Map(queue.map((it, i) => [it.id, i]))
  const byLateStart = queue.slice().sort((a, b) => late.get(a.id)!.start - late.get(b.id)!.start || rank.get(a.id)! - rank.get(b.id)!)
  const f2 = forwardPass(p, byLateStart)
  const c2 = completions(p, f2.fixed, f2.placed)
  let better = false
  let worse = false
  for (const [id, t] of c2) {
    if (t > c1.get(id)! + EPS) worse = true
    else if (t < c1.get(id)! - EPS) better = true
  }
  const placed =
    better && !worse
      ? backwardPass(p, byLateStart, c2, f2.placed, true)
      : backwardPass(p, queue, c1, f1.placed, true)

  const items: Record<string, PlannedItem> = { ...f1.fixed }
  for (const it of queue) {
    const { start } = placed.get(it.id)!
    items[it.id] = { id: it.id, orderId: it.orderId, stationId: it.stationId, start, end: start + it.duration, fixed: false }
  }
  return summarise(p, items, spreadWeight)
}

/**
 * The optimised scheduler.
 *
 * Start from the strict oldest-first plan (build above with orders by age),
 * then try swapping the priority of neighbouring orders. A swap is kept only
 * if it lowers the total cost AND no order ends more than `maxSlip` minutes
 * later than it would under strict oldest-first. That bound is measured
 * against a plan that newer orders cannot influence, so repeated re-planning
 * cannot push an old order back further and further: no starvation.
 */
export function planOptimised(input: SchedInput, options: SchedOptions = {}): Plan {
  const opt = { ...DEFAULTS, ...options }
  const p = prepare(input, opt)
  const baseline = build(p, p.orders, opt.spreadWeight)
  if (!opt.improve || p.orders.length < 2) return baseline

  let sequence = p.orders
  let best = baseline
  for (let pass = 0; pass < 2; pass++) {
    let improved = false
    for (let i = 0; i + 1 < sequence.length; i++) {
      const candidateSeq = sequence.slice()
      ;[candidateSeq[i], candidateSeq[i + 1]] = [candidateSeq[i + 1], candidateSeq[i]]
      const candidate = build(p, candidateSeq, opt.spreadWeight)
      if (candidate.cost >= best.cost - EPS) continue
      const starves = Object.values(candidate.orders).some(
        (o) => o.readyAt > baseline.orders[o.id].readyAt + opt.maxSlip + EPS,
      )
      if (starves) continue
      sequence = candidateSeq
      best = candidate
      improved = true
    }
    if (!improved) break
  }
  return best
}

/** Throws if a plan breaks station capacity or starts a queued dish in the past. Used by tests and the simulation. */
export function assertFeasible(input: SchedInput, plan: Plan): void {
  const capacity = new Map(input.stations.map((s) => [s.id, s.capacity]))
  const cookingNow = new Map<string, number>()
  for (const it of input.items) {
    const pl = plan.items[it.id]
    if (!pl) throw new Error(`item ${it.id} is missing from the plan`)
    if (it.status === 'cooking') cookingNow.set(it.stationId, (cookingNow.get(it.stationId) ?? 0) + 1)
    if (it.status === 'queued') {
      if (pl.start < input.now - 1e-6) throw new Error(`item ${it.id} is planned to start in the past`)
      if (Math.abs(pl.end - pl.start - it.duration) > 1e-6) throw new Error(`item ${it.id} has the wrong duration`)
    }
  }
  for (const [stationId, cap] of capacity) {
    // if staff already overloaded a station by hand, that is the floor we must not exceed further
    const limit = Math.max(cap, cookingNow.get(stationId) ?? 0)
    const events: [number, number][] = []
    for (const it of input.items) {
      if (it.stationId !== stationId || it.status === 'ready') continue
      const pl = plan.items[it.id]
      // round to a microminute so float noise cannot fake an overlap
      events.push([Math.round(pl.start * 1e6) / 1e6, 1], [Math.round(pl.end * 1e6) / 1e6, -1])
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let load = 0
    for (const [t, d] of events) {
      load += d
      if (load > limit) throw new Error(`station ${stationId} exceeds capacity ${limit} at t=${t}`)
    }
  }
}
