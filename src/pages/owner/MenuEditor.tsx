import { useState, type FormEvent, type ReactNode } from 'react'
import { useStaff } from '../../components/StaffShell'
import { Badge, Button, Card, Notice, Sheet, Spinner } from '../../components/ui'
import { useLive } from '../../hooks/useLive'
import { friendly, rs, SPICE } from '../../lib/format'
import { staffDb } from '../../lib/supabase'
import type { MenuCategory, MenuItem, MenuItemSize, Station } from '../../lib/types'

interface DishForm {
  name: string
  description: string
  category_id: string
  station_id: string
  price: string
  cost: string
  prep_minutes: string
  spice_level: string
  allergens: string
  is_available: boolean
}

interface SizeForm {
  name: string
  price: string
  cost: string
  prep_minutes: string
}

const EMPTY_SIZE: SizeForm = { name: '', price: '', cost: '', prep_minutes: '' }
const INPUT = 'mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal'

/** A whole number of zero or more, or null when the text is anything else. */
function toInt(text: string): number | null {
  const t = text.trim()
  return /^\d+$/.test(t) ? Number(t) : null
}

function formOf(item: MenuItem): DishForm {
  return {
    name: item.name,
    description: item.description,
    category_id: item.category_id,
    station_id: item.station_id,
    price: String(item.price),
    cost: String(item.cost),
    prep_minutes: String(item.prep_minutes),
    spice_level: String(item.spice_level),
    allergens: item.allergens.join(', '),
    is_available: item.is_available,
  }
}

const marginText = (price: number, cost: number) =>
  `${rs(price - cost)}${price > 0 ? ` (${Math.round(((price - cost) / price) * 100)}%)` : ''}`

export default function MenuEditor() {
  const member = useStaff()
  /** `id` is null while adding a new dish. */
  const [editing, setEditing] = useState<{ id: string | null; form: DishForm } | null>(null)
  const [sizeForm, setSizeForm] = useState<SizeForm>(EMPTY_SIZE)
  const [formError, setFormError] = useState<string | null>(null)
  const [formNote, setFormNote] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { data, error, refresh } = useLive(
    staffDb,
    async () => {
      const [c, i, s] = await Promise.all([
        staffDb.from('menu_categories').select('*').eq('branch_id', member.branch_id).order('sort'),
        staffDb.from('menu_items').select('*').eq('branch_id', member.branch_id).order('sort').order('name'),
        staffDb.from('stations').select('*').eq('branch_id', member.branch_id).order('sort'),
      ])
      for (const r of [c, i, s]) if (r.error) throw new Error(friendly(r.error))
      const items = (i.data ?? []) as MenuItem[]
      let sizes: MenuItemSize[] = []
      if (items.length > 0) {
        const z = await staffDb
          .from('menu_item_sizes')
          .select('*')
          .in('menu_item_id', items.map((m) => m.id))
          .order('sort')
        if (z.error) throw new Error(friendly(z.error))
        sizes = (z.data ?? []) as MenuItemSize[]
      }
      return { categories: (c.data ?? []) as MenuCategory[], items, stations: (s.data ?? []) as Station[], sizes }
    },
    [{ table: 'menu_items' }, { table: 'menu_item_sizes' }],
    [member.branch_id],
  )

  if (error && !data) return <Notice>{friendly(error)}</Notice>
  if (!data) return <Spinner label="Loading menu" />

  const { categories, items, stations, sizes } = data
  const stationName = new Map(stations.map((s) => [s.id, s.name]))
  const sizesOf = (itemId: string) => sizes.filter((s) => s.menu_item_id === itemId)
  const knownCategories = new Set(categories.map((c) => c.id))
  const orphans = items.filter((m) => !knownCategories.has(m.category_id))

  function openNew(categoryId?: string) {
    setFormError(null)
    setFormNote(null)
    setSizeForm(EMPTY_SIZE)
    setEditing({
      id: null,
      form: {
        name: '',
        description: '',
        category_id: categoryId ?? categories[0]?.id ?? '',
        station_id: stations[0]?.id ?? '',
        price: '',
        cost: '0',
        prep_minutes: '10',
        spice_level: '0',
        allergens: '',
        is_available: true,
      },
    })
  }

  function openEdit(item: MenuItem) {
    setFormError(null)
    setFormNote(null)
    setSizeForm(EMPTY_SIZE)
    setEditing({ id: item.id, form: formOf(item) })
  }

  function setField<K extends keyof DishForm>(key: K, value: DishForm[K]) {
    setEditing((e) => (e ? { ...e, form: { ...e.form, [key]: value } } : e))
  }

  async function saveDish(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    const f = editing.form
    const price = toInt(f.price)
    const cost = toInt(f.cost)
    const prep = toInt(f.prep_minutes)
    const spice = toInt(f.spice_level)
    if (!f.name.trim()) return setFormError('Give the dish a name.')
    if (!f.category_id) return setFormError('Choose a category.')
    if (!f.station_id) return setFormError('Choose a kitchen station.')
    if (price === null) return setFormError('Price must be a whole number of rupees, zero or more.')
    if (cost === null) return setFormError('Ingredient cost must be a whole number of rupees, zero or more.')
    if (prep === null || prep <= 0) return setFormError('Prep time must be a whole number of minutes, at least 1.')
    if (spice === null || spice > 3) return setFormError('Spice level must be between 0 and 3.')

    const row = {
      name: f.name.trim(),
      description: f.description.trim(),
      category_id: f.category_id,
      station_id: f.station_id,
      price,
      cost,
      prep_minutes: prep,
      spice_level: spice,
      allergens: [...new Set(f.allergens.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean))],
      is_available: f.is_available,
    }

    setBusy(true)
    setFormError(null)
    setFormNote(null)
    try {
      if (editing.id) {
        const { data: rows, error } = await staffDb.from('menu_items').update(row).eq('id', editing.id).select('id')
        if (error) throw error
        if (!rows || rows.length === 0) throw new Error('not_allowed')
        setEditing(null)
      } else {
        const sort = Math.max(0, ...items.filter((m) => m.category_id === row.category_id).map((m) => m.sort)) + 1
        const { data: created, error } = await staffDb
          .from('menu_items')
          .insert({ ...row, branch_id: member.branch_id, sort })
          .select('*')
          .single()
        if (error) throw error
        // Stay in the sheet on the new dish so sizes can be added straight away.
        setEditing({ id: (created as MenuItem).id, form: formOf(created as MenuItem) })
        setFormNote('Dish added. You can add sizes below, or close this sheet.')
      }
      await refresh()
    } catch (err) {
      setFormError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggleAvailable(item: MenuItem) {
    setBusy(true)
    setPageError(null)
    try {
      const { data: rows, error } = await staffDb
        .from('menu_items')
        .update({ is_available: !item.is_available })
        .eq('id', item.id)
        .select('id')
      if (error) throw error
      if (!rows || rows.length === 0) throw new Error('not_allowed')
      await refresh()
    } catch (err) {
      setPageError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  async function deleteDish(item: MenuItem) {
    if (!window.confirm(`Delete "${item.name}" from the menu? This cannot be undone. To hide it for now, switch it to unavailable instead.`)) return
    setBusy(true)
    setPageError(null)
    try {
      const { data: rows, error } = await staffDb.from('menu_items').delete().eq('id', item.id).select('id')
      if (error) throw error
      if (!rows || rows.length === 0) throw new Error('not_allowed')
      if (editing?.id === item.id) setEditing(null)
      await refresh()
    } catch (err) {
      setPageError(`Could not delete "${item.name}": ${friendly(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function addSize(e: FormEvent) {
    e.preventDefault()
    if (!editing?.id) return
    const price = toInt(sizeForm.price)
    const cost = toInt(sizeForm.cost)
    const prepText = sizeForm.prep_minutes.trim()
    const prep = prepText === '' ? null : toInt(prepText)
    if (!sizeForm.name.trim()) return setFormError('Give the size a name, for example Half or Full.')
    if (price === null) return setFormError('Size price must be a whole number of rupees, zero or more.')
    if (cost === null) return setFormError('Size cost must be a whole number of rupees, zero or more.')
    if (prepText !== '' && (prep === null || prep <= 0)) return setFormError('Size prep time must be at least 1 minute, or left empty.')

    setBusy(true)
    setFormError(null)
    setFormNote(null)
    try {
      const sort = Math.max(0, ...sizesOf(editing.id).map((s) => s.sort)) + 1
      const { error } = await staffDb
        .from('menu_item_sizes')
        .insert({ menu_item_id: editing.id, name: sizeForm.name.trim(), price, cost, prep_minutes: prep, sort })
      if (error) throw error
      setSizeForm(EMPTY_SIZE)
      await refresh()
    } catch (err) {
      setFormError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  async function deleteSize(size: MenuItemSize) {
    if (!window.confirm(`Delete the size "${size.name}"?`)) return
    setBusy(true)
    setFormError(null)
    setFormNote(null)
    try {
      const { data: rows, error } = await staffDb.from('menu_item_sizes').delete().eq('id', size.id).select('id')
      if (error) throw error
      if (!rows || rows.length === 0) throw new Error('not_allowed')
      await refresh()
    } catch (err) {
      setFormError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  const canAdd = categories.length > 0 && stations.length > 0
  const groups: { id: string; name: string; dishes: MenuItem[]; addTo?: string }[] = categories.map((c) => ({
    id: c.id,
    name: c.name,
    dishes: items.filter((m) => m.category_id === c.id),
    addTo: c.id,
  }))
  if (orphans.length > 0) groups.push({ id: 'other', name: 'Other', dishes: orphans })
  const editingSizes = editing?.id ? sizesOf(editing.id) : []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Menu</h1>
          <p className="text-sm text-stone-500">
            {items.length} dishes, {items.filter((m) => !m.is_available).length} hidden from guests
          </p>
        </div>
        <Button disabled={!canAdd} onClick={() => openNew()}>
          Add a dish
        </Button>
      </div>

      {error && <Notice>{friendly(error)}</Notice>}
      {pageError && <Notice>{pageError}</Notice>}
      {!canAdd && <Notice tone="amber">This branch needs at least one menu category and one kitchen station before dishes can be added.</Notice>}

      {groups.map((g) => (
        <Card key={g.id} className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">
              {g.name} <span className="text-sm font-normal text-stone-500">({g.dishes.length})</span>
            </h2>
            {g.addTo && (
              <Button size="sm" variant="ghost" disabled={!canAdd} onClick={() => openNew(g.addTo)}>
                Add to {g.name}
              </Button>
            )}
          </div>
          {g.dishes.length === 0 ? (
            <p className="text-sm text-stone-500">No dishes in this category.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-stone-500">
                  <tr className="border-b border-stone-200">
                    <th className="py-2 pr-3 font-medium">Dish</th>
                    <th className="py-2 pr-3 text-right font-medium">Price</th>
                    <th className="py-2 pr-3 text-right font-medium">Cost</th>
                    <th className="py-2 pr-3 text-right font-medium">Margin</th>
                    <th className="py-2 pr-3 text-right font-medium">Prep</th>
                    <th className="py-2 pr-3 font-medium">Station</th>
                    <th className="py-2 pr-3 font-medium">Spice</th>
                    <th className="py-2 pr-3 font-medium">Allergens</th>
                    <th className="py-2 pr-3 font-medium">Available</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {g.dishes.map((m) => {
                    const own = sizesOf(m.id)
                    return (
                      <tr key={m.id} className={`border-b border-stone-100 align-top last:border-0 ${m.is_available ? '' : 'bg-stone-50 text-stone-500'}`}>
                        <td className="py-2 pr-3">
                          <div className="font-medium">{m.name}</div>
                          {own.length > 0 && (
                            <div className="text-xs text-stone-500">
                              Sizes: {own.map((s) => `${s.name} ${rs(s.price)}`).join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{rs(m.price)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{rs(m.cost)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{marginText(m.price, m.cost)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{m.prep_minutes} min</td>
                        <td className="py-2 pr-3">{stationName.get(m.station_id) ?? 'Unknown'}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{SPICE[m.spice_level] ?? m.spice_level}</td>
                        <td className="py-2 pr-3">{m.allergens.length > 0 ? m.allergens.join(', ') : 'None'}</td>
                        <td className="py-2 pr-3">
                          <button
                            role="switch"
                            aria-checked={m.is_available}
                            aria-label={`${m.name} available`}
                            disabled={busy}
                            onClick={() => void toggleAvailable(m)}
                            className="inline-flex items-center gap-2"
                          >
                            <span className={`relative h-5 w-9 rounded-full transition-colors ${m.is_available ? 'bg-brand-600' : 'bg-stone-300'}`}>
                              <span
                                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${m.is_available ? 'left-[18px]' : 'left-0.5'}`}
                              />
                            </span>
                            <Badge tone={m.is_available ? 'green' : 'red'}>{m.is_available ? 'On menu' : 'Hidden'}</Badge>
                          </button>
                        </td>
                        <td className="py-2">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="secondary" onClick={() => openEdit(m)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void deleteDish(m)}>
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit dish' : 'Add a dish'}>
        {editing && (
          <div className="space-y-5">
            <form onSubmit={saveDish} className="space-y-3">
              {formNote && <Notice tone="green">{formNote}</Notice>}
              {formError && <Notice>{formError}</Notice>}
              <Field label="Name">
                <input className={INPUT} value={editing.form.name} onChange={(e) => setField('name', e.target.value)} required />
              </Field>
              <Field label="Description">
                <textarea className={INPUT} rows={2} value={editing.form.description} onChange={(e) => setField('description', e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Category">
                  <select className={INPUT} value={editing.form.category_id} onChange={(e) => setField('category_id', e.target.value)}>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Kitchen station">
                  <select className={INPUT} value={editing.form.station_id} onChange={(e) => setField('station_id', e.target.value)}>
                    {stations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Price (Rs)">
                  <input className={INPUT} inputMode="numeric" value={editing.form.price} onChange={(e) => setField('price', e.target.value)} />
                </Field>
                <Field label="Ingredient cost (Rs)">
                  <input className={INPUT} inputMode="numeric" value={editing.form.cost} onChange={(e) => setField('cost', e.target.value)} />
                </Field>
                <Field label="Prep time (minutes)">
                  <input
                    className={INPUT}
                    inputMode="numeric"
                    value={editing.form.prep_minutes}
                    onChange={(e) => setField('prep_minutes', e.target.value)}
                  />
                </Field>
                <Field label="Spice level">
                  <select className={INPUT} value={editing.form.spice_level} onChange={(e) => setField('spice_level', e.target.value)}>
                    {SPICE.map((label, level) => (
                      <option key={label} value={level}>
                        {level}: {label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Allergens (separate with commas)">
                <input
                  className={INPUT}
                  placeholder="dairy, nuts, gluten"
                  value={editing.form.allergens}
                  onChange={(e) => setField('allergens', e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={editing.form.is_available}
                  onChange={(e) => setField('is_available', e.target.checked)}
                />
                Available to order
              </label>
              <div className="flex gap-2 pt-1">
                <Button type="submit" disabled={busy} className="flex-1">
                  {busy ? 'Saving…' : editing.id ? 'Save changes' : 'Add dish'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                  {editing.id ? 'Close' : 'Cancel'}
                </Button>
              </div>
            </form>

            <div className="border-t border-stone-200 pt-4">
              <h3 className="text-sm font-bold">Sizes</h3>
              <p className="mb-2 text-xs text-stone-500">
                A size replaces the dish's base price, cost and prep time. Leave prep time empty to keep the dish's own.
              </p>
              {!editing.id ? (
                <p className="text-sm text-stone-500">Add the dish first, then its sizes.</p>
              ) : (
                <>
                  {editingSizes.length === 0 ? (
                    <p className="mb-3 text-sm text-stone-500">No sizes: the dish is sold at its base price.</p>
                  ) : (
                    <ul className="mb-3 divide-y divide-stone-100 rounded-xl border border-stone-200">
                      {editingSizes.map((s) => (
                        <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <div>
                            <div className="font-medium">{s.name}</div>
                            <div className="text-xs text-stone-500">
                              {rs(s.price)} · cost {rs(s.cost)} · margin {marginText(s.price, s.cost)} ·{' '}
                              {s.prep_minutes === null ? 'dish prep time' : `${s.prep_minutes} min`}
                            </div>
                          </div>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void deleteSize(s)}>
                            Delete
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form onSubmit={addSize} className="grid grid-cols-2 gap-3">
                    <Field label="Size name">
                      <input
                        className={INPUT}
                        placeholder="Half"
                        value={sizeForm.name}
                        onChange={(e) => setSizeForm({ ...sizeForm, name: e.target.value })}
                      />
                    </Field>
                    <Field label="Price (Rs)">
                      <input
                        className={INPUT}
                        inputMode="numeric"
                        value={sizeForm.price}
                        onChange={(e) => setSizeForm({ ...sizeForm, price: e.target.value })}
                      />
                    </Field>
                    <Field label="Cost (Rs)">
                      <input
                        className={INPUT}
                        inputMode="numeric"
                        value={sizeForm.cost}
                        onChange={(e) => setSizeForm({ ...sizeForm, cost: e.target.value })}
                      />
                    </Field>
                    <Field label="Prep minutes (optional)">
                      <input
                        className={INPUT}
                        inputMode="numeric"
                        value={sizeForm.prep_minutes}
                        onChange={(e) => setSizeForm({ ...sizeForm, prep_minutes: e.target.value })}
                      />
                    </Field>
                    <Button type="submit" variant="secondary" disabled={busy} className="col-span-2">
                      Add size
                    </Button>
                  </form>
                </>
              )}
            </div>
          </div>
        )}
      </Sheet>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      {children}
    </label>
  )
}
