import { useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Badge } from '../../components/ui'
import { useLive } from '../../hooks/useLive'
import { rs, SPICE } from '../../lib/format'
import { guestDb } from '../../lib/supabase'
import type { Branch, Deal, MenuCategory, MenuItem, MenuItemSize } from '../../lib/types'

export interface MenuData {
  branch: Branch | null
  categories: MenuCategory[]
  items: MenuItem[]
  sizes: MenuItemSize[]
  deals: Deal[]
}

const EMPTY: MenuData = { branch: null, categories: [], items: [], sizes: [], deals: [] }

/** Loads the menu for a branch and keeps availability live (a dish that runs out greys out on every phone). */
export function useMenu(branchId: string | undefined): MenuData {
  const { data } = useLive(
    guestDb,
    async (): Promise<MenuData> => {
      if (!branchId) return EMPTY
      const [branch, categories, items, deals] = await Promise.all([
        guestDb.from('branches').select('*').eq('id', branchId).single(),
        guestDb.from('menu_categories').select('*').eq('branch_id', branchId).order('sort'),
        guestDb.from('menu_items').select('*').eq('branch_id', branchId).order('sort'),
        guestDb.from('deals').select('*').eq('branch_id', branchId).eq('active', true),
      ])
      const ids = (items.data ?? []).map((i) => i.id)
      const sizes = ids.length ? await guestDb.from('menu_item_sizes').select('*').in('menu_item_id', ids).order('sort') : { data: [] }
      return {
        branch: branch.data as Branch | null,
        categories: (categories.data ?? []) as MenuCategory[],
        items: (items.data ?? []) as MenuItem[],
        sizes: (sizes.data ?? []) as MenuItemSize[],
        deals: (deals.data ?? []) as Deal[],
      }
    },
    [{ table: 'menu_items' }],
    [branchId],
    { enabled: !!branchId, pollMs: 60000 },
  )
  return data ?? EMPTY
}

/** Current hour of the day at the restaurant, whatever the phone's own time zone is. */
export function branchHour(timezone: string | undefined): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: timezone ?? 'Asia/Karachi' }).format(new Date())
    return Number(h) % 24
  } catch {
    return new Date().getHours()
  }
}

/** The deal that applies to a dish right now, if any. Mirrors private.item_price() in the database. */
export function activeDeal(menu: MenuData, itemId: string): Deal | null {
  const hour = branchHour(menu.branch?.timezone)
  let best: Deal | null = null
  for (const d of menu.deals) {
    if (d.menu_item_id !== itemId || !d.active || hour < d.start_hour || hour >= d.end_hour) continue
    if (!best || d.percent_off > best.percent_off) best = d
  }
  return best
}

/**
 * Price shown to the guest. The database recomputes the price when the order
 * is placed, so this is display only and cannot be used to cheat.
 */
export function priceOf(menu: MenuData, item: MenuItem, size: MenuItemSize | null | undefined): { price: number; full: number; deal: Deal | null } {
  const full = size?.price ?? item.price
  const deal = activeDeal(menu, item.id)
  return { full, deal, price: deal ? Math.round((full * (100 - deal.percent_off)) / 100) : full }
}

export function Chillies({ level }: { level: number }) {
  if (level <= 0) return null
  return (
    <span className="inline-flex text-brand-500" title={SPICE[level]} role="img" aria-label={`Spice level: ${SPICE[level]}`}>
      {Array.from({ length: level }, (_, i) => (
        <Icon key={i} name="flame" className="-ml-0.5 h-3.5 w-3.5 first:ml-0" filled />
      ))}
    </span>
  )
}

/** Menu grouped by category with sticky category chips. `onPick` makes dishes tappable. */
export function MenuBrowser({ menu, onPick }: { menu: MenuData; onPick?: (item: MenuItem) => void }) {
  const [active, setActive] = useState<string | null>(null)
  const sections = useRef<Record<string, HTMLElement | null>>({})

  const grouped = useMemo(
    () => menu.categories.map((c) => ({ category: c, items: menu.items.filter((i) => i.category_id === c.id) })).filter((g) => g.items.length),
    [menu],
  )

  if (!menu.items.length) return <p className="p-4 text-center text-sm text-stone-500">Loading the menu…</p>

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-4 flex gap-2 overflow-x-auto bg-cream/95 px-4 py-2.5 backdrop-blur [scrollbar-width:none]">
        {grouped.map(({ category }) => (
          <button
            key={category.id}
            onClick={() => {
              setActive(category.id)
              sections.current[category.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
            className={`min-h-10 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold ${
              active === category.id ? 'bg-ink text-white' : 'bg-paper text-stone-700 ring-1 ring-stone-200 hover:ring-stone-400'
            }`}
          >
            {category.name}
          </button>
        ))}
      </div>

      {grouped.map(({ category, items }) => (
        <section
          key={category.id}
          ref={(el) => {
            sections.current[category.id] = el
          }}
          className="scroll-mt-14 pt-3"
        >
          <h3 className="font-display mb-2.5 flex items-center gap-3 text-xl font-bold">
            {category.name}
            <span className="h-px flex-1 bg-stone-200" />
          </h3>
          <div className="space-y-2">
            {items.map((item) => {
              const sizes = menu.sizes.filter((s) => s.menu_item_id === item.id)
              const { price, full, deal } = priceOf(menu, item, sizes[0])
              return (
                <button
                  key={item.id}
                  disabled={!onPick || !item.is_available}
                  onClick={() => onPick?.(item)}
                  className={`block w-full rounded-2xl border border-stone-200/80 bg-paper p-4 text-left shadow-card ${
                    item.is_available ? '' : 'opacity-55'
                  } ${onPick && item.is_available ? 'hover:border-brand-200 active:bg-brand-50' : 'cursor-default'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{item.name}</span>
                        <Chillies level={item.spice_level} />
                      </div>
                      <p className="mt-0.5 text-sm leading-snug text-stone-600">{item.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {!item.is_available && <Badge tone="red">Sold out</Badge>}
                        {deal && <Badge tone="amber">{deal.title} · {deal.percent_off}% off</Badge>}
                        {sizes.length > 1 && <Badge>{sizes.length} sizes</Badge>}
                        {item.allergens.map((a) => (
                          <Badge key={a} tone="blue">{a}</Badge>
                        ))}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-bold text-brand-700">
                        {sizes.length > 1 && <span className="text-xs font-normal text-stone-500">from </span>}
                        {rs(price)}
                      </div>
                      {deal && <div className="text-xs text-stone-400 line-through">{rs(full)}</div>}
                      {onPick && item.is_available && (
                        <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white">
                          <Icon name="plus" className="h-4 w-4" /> Add
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
      <p className="py-4 text-center text-xs text-stone-500">
        Allergen tags are a guide. If you have an allergy, please tell a member of staff.
      </p>
    </div>
  )
}
