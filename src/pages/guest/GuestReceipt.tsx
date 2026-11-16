import { useState } from 'react'
import { EmberBackdrop } from '../../components/EmberBackdrop'
import { Icon } from '../../components/Icon'
import { Button, Hero, Notice, Simulated, Spinner } from '../../components/ui'
import { useLive } from '../../hooks/useLive'
import { friendly, rs } from '../../lib/format'
import { guestDb } from '../../lib/supabase'
import type { Bill, BillShare, OrderItem, TableView } from '../../lib/types'
import { PAY_METHODS } from './GuestSession'

/**
 * Shown after the session has closed (bill paid). The guest can still read
 * their receipt and rate the visit, but the database refuses any new order
 * against this session.
 */
export default function GuestReceipt({ view, sessionId, onDone }: { view: TableView; sessionId: string; onDone: () => void }) {
  const [stars, setStars] = useState(0)
  const [comment, setComment] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data, loading } = useLive(
    guestDb,
    async () => {
      const [bill, shares, items] = await Promise.all([
        guestDb.from('bills').select('*').eq('session_id', sessionId).maybeSingle(),
        guestDb.from('bill_shares').select('*').eq('session_id', sessionId),
        guestDb.from('order_items').select('*').eq('session_id', sessionId).neq('status', 'cancelled'),
      ])
      return { bill: bill.data as Bill | null, shares: (shares.data ?? []) as BillShare[], items: (items.data ?? []) as OrderItem[] }
    },
    [],
    [sessionId],
    { pollMs: 60000 },
  )

  async function rate() {
    setError(null)
    const { error } = await guestDb.rpc('submit_rating', { p_session: sessionId, p_stars: stars, p_comment: comment.trim() })
    if (error) setError(friendly(error))
    else setSent(true)
  }

  if (loading) return <Spinner label="Loading your receipt" />

  const bill = data?.bill
  return (
    <div className="mx-auto min-h-full max-w-md bg-cream">
      <Hero eyebrow={`Table ${view.label}`} title="Thank you for visiting" backdrop={<EmberBackdrop />}>
        <p className="mt-2 text-sm text-white/80">{view.restaurant_name}</p>
      </Hero>
      <div className="-mt-3 space-y-4 rounded-t-3xl bg-cream p-4">
        {bill ? (
          <div className="rounded-2xl border border-stone-200/80 bg-paper p-4 shadow-card">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-bold">Receipt</h2>
              <Simulated>Simulated payment</Simulated>
            </div>
            <ul className="space-y-1 text-sm">
              {data!.items.map((i) => (
                <li key={i.id} className="flex justify-between">
                  <span>
                    {i.name}
                    {i.size_name ? ` (${i.size_name})` : ''}
                  </span>
                  <span>{rs(i.unit_price * i.qty)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 space-y-1 border-t border-stone-200 pt-3 text-sm text-stone-600">
              <div className="flex justify-between"><span>Subtotal</span><span>{rs(bill.subtotal)}</span></div>
              <div className="flex justify-between"><span>Sales tax</span><span>{rs(bill.tax)}</span></div>
              {bill.tip > 0 && <div className="flex justify-between"><span>Tip</span><span>{rs(bill.tip)}</span></div>}
              <div className="flex justify-between pt-1 text-base font-bold text-ink"><span>Total paid</span><span>{rs(bill.total)}</span></div>
            </div>
            <p className="mt-3 text-xs text-stone-500">
              Paid by: {data!.shares.map((s) => `${s.label} (${PAY_METHODS.find((m) => m.id === s.method)?.label ?? s.method ?? 'unpaid'})`).join(', ')}.
              This is not a tax invoice.
            </p>
          </div>
        ) : (
          <Notice tone="amber">This visit has ended. Staff closed the table.</Notice>
        )}

        <div className="rounded-2xl border border-stone-200/80 bg-paper p-5 text-center shadow-card">
          {sent ? (
            <p className="flex items-center justify-center gap-2 py-3 font-semibold text-brand-700">
              <Icon name="check" /> Thank you for your rating
            </p>
          ) : (
            <>
              <h2 className="font-bold">How was your visit?</h2>
              <div className="my-3 flex justify-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => setStars(n)} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={`flex h-12 w-12 items-center justify-center ${n <= stars ? 'text-saffron-500' : 'text-stone-300 hover:text-saffron-400'}`}>
                    <Icon name="star" className="h-9 w-9" filled />
                  </button>
                ))}
              </div>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={300}
                placeholder="Anything we should know? (optional)"
                className="w-full rounded-xl border border-stone-300 px-3 py-3 text-base"
              />
              {error && <div className="mt-2"><Notice>{error}</Notice></div>}
              <Button className="mt-3 w-full" disabled={stars === 0} onClick={rate}>
                Send rating
              </Button>
            </>
          )}
        </div>

        <Button variant="secondary" className="w-full" onClick={onDone}>
          Start a new visit at this table
        </Button>
      </div>
    </div>
  )
}
