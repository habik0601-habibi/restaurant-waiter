import { useMemo, useState, type ReactNode } from 'react'
import { useStaff } from '../../components/StaffShell'
import { Badge, Button, Card, Notice, Simulated, Spinner } from '../../components/ui'
import { useLive } from '../../hooks/useLive'
import { friendly, rs } from '../../lib/format'
import { staffDb } from '../../lib/supabase'
import type { Deal } from '../../lib/types'

// ------------------------------------------------------------------ types

interface Summary {
  orders: number
  sample_orders: number
  revenue: number
  profit: number
  today_orders: number
  today_revenue: number
  days: number
  rating_avg: number | null
  rating_count: number
  live_orders: number
  tables_active: number
  tables_total: number
}

interface MenuStat {
  menu_item_id: string
  name: string
  category: string
  price: number
  cost: number
  units: number
  revenue: number
  profit: number
  sample_units: number
}

interface HourRow {
  hour: number
  orders: number
  revenue: number
  sample_orders: number
}

type Quadrant = 'star' | 'popular_low' | 'margin_rare' | 'weak'

interface Dish extends MenuStat {
  /** Margin per unit at the base price (price minus ingredient cost). */
  margin: number
  /** Margin as a percentage of the base price. */
  marginPct: number
  quadrant: Quadrant
}

interface SlowWindow {
  /** First slow hour (inclusive). */
  start: number
  /** End of the window (exclusive), so 15-17 covers 15:00 to 17:00. */
  end: number
  orders: number
}

interface Suggestion {
  dish: Dish
  percentOff: number
  marginLeft: number
  marginLeftPct: number
  title: string
}

const QUADRANTS: Record<Quadrant, { label: string; color: string; tone: 'green' | 'amber' | 'blue' | 'stone' }> = {
  star: { label: 'Stars', color: '#1f7a4d', tone: 'green' },
  popular_low: { label: 'Popular, low margin', color: '#d98e12', tone: 'amber' },
  margin_rare: { label: 'High margin, rarely ordered', color: '#a93620', tone: 'blue' },
  weak: { label: 'Weak', color: '#78716c', tone: 'stone' },
}
const QUADRANT_ORDER: Quadrant[] = ['star', 'popular_low', 'margin_rare', 'weak']

const PERIODS = [7, 14, 28]
/** Opening hours 12:00-23:00, as hour buckets 12..22. */
const OPEN_FROM = 12
const OPEN_TO = 23
const CHART_HOURS = Array.from({ length: 13 }, (_, i) => i + 11)

// ---------------------------------------------------------------- helpers

const num = (n: number) => Math.round(n).toLocaleString('en-PK')
const pct = (n: number) => `${Math.round(n)}%`

function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24
  if (x === 0) return '12 am'
  if (x === 12) return '12 pm'
  return x < 12 ? `${x} am` : `${x - 12} pm`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Round axis ticks covering [min, max]. */
function niceTicks(min: number, max: number, target = 5): number[] {
  const span = max - min || 1
  const raw = span / target
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100)
  return ticks
}

function classify(stats: MenuStat[]): { dishes: Dish[]; medUnits: number; medMargin: number } {
  const rows = stats.map((s) => ({
    ...s,
    price: Number(s.price),
    cost: Number(s.cost),
    units: Number(s.units),
    revenue: Number(s.revenue),
    profit: Number(s.profit),
    sample_units: Number(s.sample_units),
  }))
  const medUnits = median(rows.map((r) => r.units))
  const medMargin = median(rows.map((r) => r.price - r.cost))
  const dishes = rows.map((r): Dish => {
    const margin = r.price - r.cost
    const popular = r.units > 0 && r.units >= medUnits
    const rich = margin >= medMargin
    return {
      ...r,
      margin,
      marginPct: r.price > 0 ? (margin / r.price) * 100 : 0,
      quadrant: popular ? (rich ? 'star' : 'popular_low') : rich ? 'margin_rare' : 'weak',
    }
  })
  return { dishes, medUnits, medMargin }
}

/** The three slowest opening hours, with neighbouring hours merged into one window. */
function slowWindows(byHour: Map<number, number>): SlowWindow[] {
  const hours: { hour: number; orders: number }[] = []
  for (let h = OPEN_FROM; h < OPEN_TO; h++) hours.push({ hour: h, orders: byHour.get(h) ?? 0 })
  const slowest = [...hours]
    .sort((a, b) => a.orders - b.orders || a.hour - b.hour)
    .slice(0, 3)
    .sort((a, b) => a.hour - b.hour)
  const windows: SlowWindow[] = []
  for (const h of slowest) {
    const last = windows[windows.length - 1]
    if (last && last.end === h.hour) {
      last.end = h.hour + 1
      last.orders += h.orders
    } else {
      windows.push({ start: h.hour, end: h.hour + 1, orders: h.orders })
    }
  }
  return windows
}

/** Discount of half the margin percentage, capped at 25, rounded down to a multiple of 5. */
function suggestFor(dish: Dish): Suggestion | null {
  const percentOff = Math.floor(Math.min(25, Math.floor(dish.marginPct / 2)) / 5) * 5
  if (percentOff < 5) return null
  const newPrice = Math.round(dish.price * (1 - percentOff / 100))
  const marginLeft = newPrice - dish.cost
  if (marginLeft <= 0) return null
  return {
    dish,
    percentOff,
    marginLeft,
    marginLeftPct: newPrice > 0 ? (marginLeft / newPrice) * 100 : 0,
    title: `${percentOff}% off ${dish.name}`,
  }
}

// ------------------------------------------------------------------- page

export default function Dashboard() {
  const member = useStaff()
  const [days, setDays] = useState(28)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const { data, error, loading, refresh } = useLive(
    staffDb,
    async () => {
      const args = { p_branch: member.branch_id, p_days: days }
      const [s, m, h, d] = await Promise.all([
        staffDb.rpc('owner_summary', args),
        staffDb.rpc('owner_menu_stats', args),
        staffDb.rpc('owner_hourly', args),
        staffDb.from('deals').select('*').eq('branch_id', member.branch_id).order('created_at'),
      ])
      for (const r of [s, m, h, d]) if (r.error) throw new Error(friendly(r.error))
      return {
        summary: s.data as Summary,
        stats: (m.data ?? []) as MenuStat[],
        hourly: (h.data ?? []) as HourRow[],
        deals: (d.data ?? []) as Deal[],
      }
    },
    [{ table: 'deals' }],
    [member.branch_id, days],
    { pollMs: 60000 },
  )

  const model = useMemo(() => {
    if (!data) return null
    const { dishes, medUnits, medMargin } = classify(data.stats)
    const byHour = new Map<number, number>()
    for (const h of data.hourly) byHour.set(Number(h.hour), Number(h.orders))
    const hourTotal = [...byHour.values()].reduce((a, b) => a + b, 0)
    const windows = hourTotal > 0 ? slowWindows(byHour) : []
    const candidates = dishes
      .filter((d) => d.quadrant === 'margin_rare')
      .map(suggestFor)
      .filter((s): s is Suggestion => s !== null)
      .sort((a, b) => b.dish.marginPct - a.dish.marginPct)
    // Rotate through the candidates so each window gets different dishes when there are enough.
    const plans = windows.map((w, i) => {
      const picks: Suggestion[] = []
      for (let k = 0; k < Math.min(3, candidates.length); k++) {
        const pick = candidates[(i * 3 + k) % candidates.length]
        if (!picks.includes(pick)) picks.push(pick)
      }
      return { window: w, picks }
    })
    const sampleUnits = dishes.reduce((a, d) => a + d.sample_units, 0)
    const totalUnits = dishes.reduce((a, d) => a + d.units, 0)
    return { dishes, medUnits, medMargin, byHour, windows, plans, sampleUnits, totalUnits }
  }, [data])

  if (error && !data) return <Notice>{friendly(error)}</Notice>
  if (!data || !model) return <Spinner label="Loading dashboard" />

  const { summary, deals } = data
  const { dishes, medUnits, medMargin, byHour, windows, plans, sampleUnits, totalUnits } = model
  const orders = Number(summary.orders)
  const sampleOrders = Number(summary.sample_orders)
  const revenue = Number(summary.revenue)
  const profit = Number(summary.profit)
  const periodDays = Number(summary.days) || days
  const hasSample = sampleOrders > 0 || sampleUnits > 0 || data.hourly.some((h) => Number(h.sample_orders) > 0)
  const sampleTag = hasSample ? <Simulated>Sample data</Simulated> : null
  const dishName = new Map(dishes.map((d) => [d.menu_item_id, d.name]))
  const popularLow = dishes.filter((d) => d.quadrant === 'popular_low').sort((a, b) => b.units - a.units)
  const marginRare = dishes.filter((d) => d.quadrant === 'margin_rare').sort((a, b) => b.margin - a.margin)

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    setActionError(null)
    try {
      await action()
      await refresh()
    } catch (e) {
      setActionError(friendly(e))
    } finally {
      setBusy(null)
    }
  }

  const createDeal = (w: SlowWindow, s: Suggestion) =>
    run(`create-${w.start}-${s.dish.menu_item_id}`, async () => {
      const { error } = await staffDb.from('deals').insert({
        branch_id: member.branch_id,
        menu_item_id: s.dish.menu_item_id,
        title: s.title,
        percent_off: s.percentOff,
        start_hour: w.start,
        end_hour: w.end,
        active: true,
      })
      if (error) throw error
    })

  const toggleDeal = (d: Deal) =>
    run(`deal-${d.id}`, async () => {
      const { data: rows, error } = await staffDb.from('deals').update({ active: !d.active }).eq('id', d.id).select('id')
      if (error) throw error
      if (!rows || rows.length === 0) throw new Error('not_allowed')
    })

  const deleteDeal = (d: Deal) => {
    if (!window.confirm(`Delete the deal "${d.title}"?`)) return
    void run(`deal-${d.id}`, async () => {
      const { data: rows, error } = await staffDb.from('deals').delete().eq('id', d.id).select('id')
      if (error) throw error
      if (!rows || rows.length === 0) throw new Error('not_allowed')
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Menu profit dashboard</h1>
          <p className="text-sm text-stone-500">
            Last {periodDays} days{loading ? ' · updating…' : ''}
          </p>
        </div>
        <div className="flex gap-1 rounded-xl border border-stone-300 bg-paper p-1" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setDays(p)}
              aria-pressed={days === p}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${days === p ? 'bg-brand-600 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
            >
              {p} days
            </button>
          ))}
        </div>
      </div>

      {hasSample && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Simulated>Sample data</Simulated>
          <span>
            <strong>
              {num(sampleOrders)} of {num(orders)} orders
            </strong>{' '}
            in this period ({num(sampleUnits)} of {num(totalUnits)} dishes sold) were generated by the seed script, not real sales. Every
            figure and chart below includes them.
          </span>
        </div>
      )}

      {error && <Notice>{friendly(error)}</Notice>}
      {actionError && <Notice>{actionError}</Notice>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Orders" value={num(orders)} sub={`${num(Number(summary.today_orders))} today`} />
        <Tile label="Revenue" value={rs(revenue)} sub={`${rs(Number(summary.today_revenue))} today`} />
        <Tile
          label="Gross profit"
          value={rs(profit)}
          sub={revenue > 0 ? `${pct((profit / revenue) * 100)} of revenue, after ingredient cost` : 'Revenue minus ingredient cost'}
        />
        <Tile label="Average order value" value={orders > 0 ? rs(revenue / orders) : 'No orders'} sub="Revenue per order" />
        <Tile
          label="Guest rating"
          value={summary.rating_avg === null ? 'No ratings yet' : `${Number(summary.rating_avg).toFixed(1)} / 5`}
          sub={summary.rating_avg === null ? 'All time' : `${num(Number(summary.rating_count))} ratings, all time`}
        />
        <Tile label="Live orders now" value={num(Number(summary.live_orders))} sub="Real orders still open" />
        <Tile label="Tables active" value={`${summary.tables_active} / ${summary.tables_total}`} sub="Right now" />
      </div>

      <Card className="p-4">
        <ChartTitle title="Menu engineering matrix" tag={sampleTag}>
          Each dot is a dish: how often it was ordered against what it earns per plate. The dashed lines are the medians.
        </ChartTitle>
        <Matrix dishes={dishes} medUnits={medUnits} medMargin={medMargin} />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
          {QUADRANT_ORDER.map((q) => (
            <span key={q} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: QUADRANTS[q].color }} />
              {QUADRANTS[q].label} ({dishes.filter((d) => d.quadrant === q).length})
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-stone-500">
          Margin per unit uses the dish's base price and ingredient cost. Dishes sold in sizes can earn more or less per plate.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Highlight
          title="Popular but low-margin"
          advice="These sell well but earn little per plate. Raise the price slightly or cut the ingredient cost."
          dishes={popularLow}
          tag={sampleTag}
        />
        <Highlight
          title="High-margin but rarely ordered"
          advice="These earn well but few guests order them. Promote them, have waiters recommend them, or feature them in a deal."
          dishes={marginRare}
          tag={sampleTag}
        />
      </div>

      <Card className="p-4">
        <ChartTitle title="Orders by hour of day" tag={sampleTag}>
          Total orders in the last {periodDays} days by restaurant-local hour. The slowest opening hours are highlighted.
        </ChartTitle>
        <HourChart byHour={byHour} windows={windows} days={periodDays} />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-brand-500" /> Orders
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-saffron-500" /> Slowest hours
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-stone-300" /> Outside 12 pm to 11 pm
          </span>
        </div>
      </Card>

      <Card className="p-4">
        <ChartTitle title="Deal suggestions for the slowest hours" tag={sampleTag}>
          High-margin dishes that are rarely ordered, discounted by about half their margin (25% at most) during the quietest hours.
        </ChartTitle>
        {windows.length === 0 ? (
          <p className="text-sm text-stone-500">No orders in this period yet, so there are no slow hours to suggest deals for.</p>
        ) : plans.every((p) => p.picks.length === 0) ? (
          <p className="text-sm text-stone-500">
            Slowest hours: {windows.map((w) => `${hourLabel(w.start)} to ${hourLabel(w.end)}`).join(', ')}. No high-margin, rarely ordered
            dish has enough margin for a discount.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            {plans.map(({ window: w, picks }) => (
              <div key={w.start} className="rounded-xl border border-stone-200 p-3">
                <div className="font-semibold">
                  {hourLabel(w.start)} to {hourLabel(w.end)}
                </div>
                <div className="mb-3 text-xs text-stone-500">
                  {num(w.orders)} orders in {periodDays} days ({(w.orders / periodDays).toFixed(1)} per day)
                </div>
                <ul className="space-y-3">
                  {picks.map((s) => {
                    const exists = deals.some(
                      (d) => d.menu_item_id === s.dish.menu_item_id && d.start_hour === w.start && d.end_hour === w.end,
                    )
                    const key = `create-${w.start}-${s.dish.menu_item_id}`
                    return (
                      <li key={s.dish.menu_item_id} className="space-y-1.5 border-t border-stone-100 pt-3 first:border-0 first:pt-0">
                        <div className="text-sm font-medium">{s.title}</div>
                        <div className="text-xs text-stone-600">
                          {rs(s.dish.price)} becomes {rs(Math.round(s.dish.price * (1 - s.percentOff / 100)))}. Margin left:{' '}
                          {rs(s.marginLeft)} per plate ({pct(s.marginLeftPct)}), down from {rs(s.dish.margin)} ({pct(s.dish.marginPct)}).
                        </div>
                        {exists ? (
                          <Badge tone="green">Deal already exists</Badge>
                        ) : (
                          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void createDeal(w, s)}>
                            {busy === key ? 'Creating…' : 'Create this deal'}
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        <h3 className="mb-2 mt-6 text-sm font-semibold">Existing deals</h3>
        {deals.length === 0 ? (
          <p className="text-sm text-stone-500">No deals yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-stone-500">
                <tr className="border-b border-stone-200">
                  <th className="py-2 pr-3 font-medium">Deal</th>
                  <th className="py-2 pr-3 font-medium">Dish</th>
                  <th className="py-2 pr-3 font-medium">Discount</th>
                  <th className="py-2 pr-3 font-medium">Hours</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.id} className="border-b border-stone-100 last:border-0">
                    <td className="py-2 pr-3 font-medium">{d.title}</td>
                    <td className="py-2 pr-3">{dishName.get(d.menu_item_id) ?? 'Unknown dish'}</td>
                    <td className="py-2 pr-3">{d.percent_off}% off</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {hourLabel(d.start_hour)} to {hourLabel(d.end_hour)}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={d.active ? 'green' : 'stone'}>{d.active ? 'Active' : 'Inactive'}</Badge>
                    </td>
                    <td className="py-2">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void toggleDeal(d)}>
                          {d.active ? 'Switch off' : 'Switch on'}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => deleteDeal(d)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <ChartTitle title="All dishes" tag={sampleTag}>
          Click a column heading to sort.
        </ChartTitle>
        <DishTable dishes={dishes} />
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ parts

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-stone-500">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-stone-500">{sub}</div>}
    </Card>
  )
}

function ChartTitle({ title, tag, children }: { title: string; tag: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">{title}</h2>
        {tag}
      </div>
      {children && <p className="text-sm text-stone-500">{children}</p>}
    </div>
  )
}

function Highlight({ title, advice, dishes, tag }: { title: string; advice: string; dishes: Dish[]; tag: ReactNode }) {
  return (
    <Card className="p-4">
      <ChartTitle title={title} tag={tag}>
        {advice}
      </ChartTitle>
      {dishes.length === 0 ? (
        <p className="text-sm text-stone-500">No dishes in this group for this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-stone-500">
              <tr className="border-b border-stone-200">
                <th className="py-2 pr-3 font-medium">Dish</th>
                <th className="py-2 pr-3 text-right font-medium">Units</th>
                <th className="py-2 pr-3 text-right font-medium">Margin / unit</th>
                <th className="py-2 pr-3 text-right font-medium">Margin %</th>
                <th className="py-2 text-right font-medium">Total profit</th>
              </tr>
            </thead>
            <tbody>
              {dishes.map((d) => (
                <tr key={d.menu_item_id} className="border-b border-stone-100 last:border-0">
                  <td className="py-2 pr-3 font-medium">{d.name}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{num(d.units)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{rs(d.margin)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pct(d.marginPct)}</td>
                  <td className="py-2 text-right tabular-nums">{rs(d.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function Matrix({ dishes, medUnits, medMargin }: { dishes: Dish[]; medUnits: number; medMargin: number }) {
  if (dishes.length === 0) return <p className="text-sm text-stone-500">There are no dishes on the menu yet.</p>

  const W = 760
  const H = 440
  const left = 64
  const right = 16
  const top = 14
  const bottom = 46
  const plotW = W - left - right
  const plotH = H - top - bottom

  const xTicks = niceTicks(0, Math.max(1, ...dishes.map((d) => d.units)))
  const yTicks = niceTicks(Math.min(0, ...dishes.map((d) => d.margin)), Math.max(1, ...dishes.map((d) => d.margin)))
  const xMax = xTicks[xTicks.length - 1]
  const yMin = yTicks[0]
  const yMax = yTicks[yTicks.length - 1]
  const x = (v: number) => left + (v / xMax) * plotW
  const y = (v: number) => top + plotH - ((v - yMin) / (yMax - yMin)) * plotH
  const mx = x(Math.min(medUnits, xMax))
  const my = y(medMargin)

  // Label only the most notable dishes of each quadrant so names do not pile up.
  const labelled = new Set<string>()
  for (const q of QUADRANT_ORDER) {
    const group = dishes.filter((d) => d.quadrant === q)
    const ranked =
      q === 'star' || q === 'popular_low' ? group.sort((a, b) => b.units - a.units) : group.sort((a, b) => b.margin - a.margin)
    for (const d of ranked.slice(0, 4)) labelled.add(d.menu_item_id)
  }
  const short = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Scatter plot of dishes by units sold and margin per unit">
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={x(t)} x2={x(t)} y1={top} y2={top + plotH} stroke="#e7e5e4" />
          <text x={x(t)} y={top + plotH + 16} textAnchor="middle" fontSize="11" fill="#78716c">
            {num(t)}
          </text>
        </g>
      ))}
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} stroke="#e7e5e4" />
          <text x={left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#78716c">
            {num(t)}
          </text>
        </g>
      ))}
      <rect x={left} y={top} width={plotW} height={plotH} fill="none" stroke="#a8a29e" />

      <line x1={mx} x2={mx} y1={top} y2={top + plotH} stroke="#57534e" strokeDasharray="5 4" />
      <line x1={left} x2={left + plotW} y1={my} y2={my} stroke="#57534e" strokeDasharray="5 4" />

      <text x={left + plotW - 8} y={top + 16} textAnchor="end" fontSize="12" fontWeight="700" fill={QUADRANTS.star.color} opacity="0.75">
        {QUADRANTS.star.label}
      </text>
      <text x={left + plotW - 8} y={top + plotH - 8} textAnchor="end" fontSize="12" fontWeight="700" fill={QUADRANTS.popular_low.color} opacity="0.85">
        {QUADRANTS.popular_low.label}
      </text>
      <text x={left + 8} y={top + 16} fontSize="12" fontWeight="700" fill={QUADRANTS.margin_rare.color} opacity="0.75">
        {QUADRANTS.margin_rare.label}
      </text>
      <text x={left + 8} y={top + plotH - 8} fontSize="12" fontWeight="700" fill={QUADRANTS.weak.color} opacity="0.85">
        {QUADRANTS.weak.label}
      </text>

      {dishes.map((d) => {
        const cx = x(d.units)
        const cy = y(d.margin)
        const flip = cx > left + plotW * 0.72
        return (
          <g key={d.menu_item_id}>
            <circle cx={cx} cy={cy} r="6" fill={QUADRANTS[d.quadrant].color} fillOpacity="0.8" stroke="#fff" strokeWidth="1.5">
              <title>
                {`${d.name}: ${num(d.units)} units, margin ${rs(d.margin)} per unit (${pct(d.marginPct)}), ${QUADRANTS[d.quadrant].label}`}
              </title>
            </circle>
            {labelled.has(d.menu_item_id) && (
              <text
                x={flip ? cx - 9 : cx + 9}
                y={cy + 3.5}
                textAnchor={flip ? 'end' : 'start'}
                fontSize="10"
                fill="#1c1917"
                stroke="#fff"
                strokeWidth="3"
                paintOrder="stroke"
              >
                {short(d.name)}
              </text>
            )}
          </g>
        )
      })}

      <text x={left + plotW / 2} y={H - 8} textAnchor="middle" fontSize="12" fill="#44403c">
        Popularity: units sold (median {num(medUnits)})
      </text>
      <text transform={`translate(14 ${top + plotH / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="#44403c">
        Margin per unit, Rs (median {num(medMargin)})
      </text>
    </svg>
  )
}

function HourChart({ byHour, windows, days }: { byHour: Map<number, number>; windows: SlowWindow[]; days: number }) {
  const W = 760
  const H = 280
  const left = 44
  const right = 12
  const top = 22
  const bottom = 48
  const plotW = W - left - right
  const plotH = H - top - bottom

  const values = CHART_HOURS.map((h) => ({ hour: h, orders: byHour.get(h) ?? 0 }))
  const ticks = niceTicks(0, Math.max(1, ...values.map((v) => v.orders)), 4)
  const yMax = ticks[ticks.length - 1]
  const band = plotW / values.length
  const barW = band * 0.64
  const y = (v: number) => top + plotH - (v / yMax) * plotH
  const isSlow = (h: number) => windows.some((w) => h >= w.start && h < w.end)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Bar chart of orders by hour of day">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} stroke="#e7e5e4" />
          <text x={left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#78716c">
            {num(t)}
          </text>
        </g>
      ))}
      {values.map((v, i) => {
        const open = v.hour >= OPEN_FROM && v.hour < OPEN_TO
        const slow = isSlow(v.hour)
        const bx = left + i * band + (band - barW) / 2
        const perDay = v.orders / days
        return (
          <g key={v.hour}>
            <rect
              x={bx}
              y={y(v.orders)}
              width={barW}
              height={top + plotH - y(v.orders)}
              rx="3"
              fill={slow ? '#e08e0b' : open ? '#2f7d4a' : '#d6d3d1'}
            >
              <title>{`${hourLabel(v.hour)} to ${hourLabel(v.hour + 1)}: ${num(v.orders)} orders, ${perDay.toFixed(1)} per day${slow ? ' (one of the slowest hours)' : ''}`}</title>
            </rect>
            <text x={bx + barW / 2} y={y(v.orders) - 5} textAnchor="middle" fontSize="11" fontWeight="600" fill="#1c1917">
              {num(v.orders)}
            </text>
            <text x={bx + barW / 2} y={top + plotH + 16} textAnchor="middle" fontSize="11" fill="#44403c" fontWeight={slow ? 700 : 400}>
              {hourLabel(v.hour)}
            </text>
            <text x={bx + barW / 2} y={top + plotH + 31} textAnchor="middle" fontSize="10" fill="#78716c">
              {perDay.toFixed(1)}/day
            </text>
          </g>
        )
      })}
      <line x1={left} x2={left + plotW} y1={top + plotH} y2={top + plotH} stroke="#a8a29e" />
    </svg>
  )
}

type SortKey = 'name' | 'category' | 'price' | 'cost' | 'margin' | 'marginPct' | 'units' | 'revenue' | 'profit' | 'quadrant'

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Dish', numeric: false },
  { key: 'category', label: 'Category', numeric: false },
  { key: 'price', label: 'Price', numeric: true },
  { key: 'cost', label: 'Cost', numeric: true },
  { key: 'margin', label: 'Margin', numeric: true },
  { key: 'marginPct', label: 'Margin %', numeric: true },
  { key: 'units', label: 'Units', numeric: true },
  { key: 'revenue', label: 'Revenue', numeric: true },
  { key: 'profit', label: 'Profit', numeric: true },
  { key: 'quadrant', label: 'Quadrant', numeric: false },
]

function DishTable({ dishes }: { dishes: Dish[] }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'profit', desc: true })

  const sorted = useMemo(() => {
    const value = (d: Dish): string | number => (sort.key === 'quadrant' ? QUADRANT_ORDER.indexOf(d.quadrant) : d[sort.key])
    return [...dishes].sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sort.desc ? -c : c
    })
  }, [dishes, sort])

  const pick = (key: SortKey, numeric: boolean) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: numeric }))

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-stone-500">
          <tr className="border-b border-stone-200">
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className={`py-2 pr-3 font-medium ${c.numeric ? 'text-right' : ''}`}
                aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
              >
                <button onClick={() => pick(c.key, c.numeric)} className="whitespace-nowrap hover:text-ink">
                  {c.label}
                  {sort.key === c.key ? (sort.desc ? ' ▼' : ' ▲') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d.menu_item_id} className="border-b border-stone-100 last:border-0">
              <td className="py-2 pr-3 font-medium">{d.name}</td>
              <td className="py-2 pr-3 text-stone-600">{d.category}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{rs(d.price)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{rs(d.cost)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{rs(d.margin)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{pct(d.marginPct)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{num(d.units)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{rs(d.revenue)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{rs(d.profit)}</td>
              <td className="py-2 pr-3 whitespace-nowrap">
                <Badge tone={QUADRANTS[d.quadrant].tone}>{QUADRANTS[d.quadrant].label}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
