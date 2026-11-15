import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Notice, Spinner } from '../../components/ui'
import { useLive } from '../../hooks/useLive'
import { friendly } from '../../lib/format'
import { ensureGuest, guestDb } from '../../lib/supabase'
import type { TableView } from '../../lib/types'
import GuestSession from './GuestSession'
import GuestReceipt from './GuestReceipt'
import { MenuBrowser, useMenu } from './menu'

const lastSessionKey = (tableId: string) => `zaiqa-last-session-${tableId}`

/**
 * Entry point for a scanned table QR code: /t/<signed token>.
 *
 * The token only identifies the table. What this phone may do is decided by
 * the database from (a) the table's live session and (b) this phone's guest
 * row in it. The screen simply mirrors that state:
 *
 *   no session / not asked yet  -> "Request to order"
 *   asked, not yet approved     -> waiting screen (menu is browsable)
 *   approved, session open      -> the ordering app
 *   session closed (paid)       -> receipt and rating
 */
export default function GuestTable() {
  const { token = '' } = useParams()
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [name, setName] = useState(() => localStorage.getItem('zaiqa-name') ?? '')
  const [party, setParty] = useState(2)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastSession, setLastSession] = useState<string | null>(null)

  useEffect(() => {
    ensureGuest()
      .then(() => setReady(true))
      .catch((e) => setFatal(friendly(e)))
  }, [])

  const fetchView = useCallback(async (): Promise<TableView> => {
    const { data, error } = await guestDb.rpc('resolve_table', { p_token: token })
    if (error) throw new Error(friendly(error))
    return data as TableView
  }, [token])

  // RLS only delivers rows this phone may see, so no filter is needed here.
  const { data: view, error, refresh } = useLive(
    guestDb,
    fetchView,
    [{ table: 'table_sessions' }, { table: 'session_guests' }],
    [token],
    { enabled: ready, pollMs: 6000 },
  )

  const menu = useMenu(view?.branch_id)

  // Remember the session we were part of, so the receipt survives the close.
  useEffect(() => {
    if (!view) return
    const key = lastSessionKey(view.table_id)
    if (view.session_id && view.guest_status === 'approved') {
      localStorage.setItem(key, view.session_id)
      setLastSession(view.session_id)
    } else {
      setLastSession(localStorage.getItem(key))
    }
  }, [view])

  async function request() {
    setBusy(true)
    setActionError(null)
    localStorage.setItem('zaiqa-name', name.trim())
    const { error } = await guestDb.rpc('request_session', { p_token: token, p_name: name.trim() || 'Guest', p_party_size: party })
    if (error) setActionError(friendly(error))
    await refresh()
    setBusy(false)
  }

  if (fatal) return <Shell><Notice>{fatal}</Notice></Shell>
  if (error && !view) {
    return (
      <Shell>
        <Notice>{error}</Notice>
        <p className="mt-3 text-sm text-stone-600">Please scan the code on your table again, or ask a member of staff.</p>
      </Shell>
    )
  }
  if (!view) return <Spinner label="Finding your table" />

  const approved = view.guest_status === 'approved' && view.session_status === 'open'

  if (approved && view.session_id && view.guest_id) {
    return <GuestSession view={view} sessionId={view.session_id} guestId={view.guest_id} menu={menu} />
  }

  // The visit we took part in has ended: show the receipt until the guest dismisses it.
  if (lastSession && lastSession !== view.session_id && !view.guest_id) {
    return (
      <GuestReceipt
        view={view}
        sessionId={lastSession}
        onDone={() => {
          localStorage.removeItem(lastSessionKey(view.table_id))
          setLastSession(null)
        }}
      />
    )
  }

  const pending = view.guest_status === 'pending'
  const denied = view.guest_status === 'denied'
  const expired = view.session_status === 'expired'
  const tableOpen = view.session_status === 'open'

  return (
    <Shell title={view.restaurant_name} subtitle={`${view.branch_name} · Table ${view.label}`}>
      {expired && <Notice tone="amber">This table&apos;s session has expired. Please ask a member of staff to reopen it.</Notice>}

      {pending && (
        <div className="rounded-2xl bg-white p-5 text-center shadow-sm">
          <span className="mx-auto mb-3 block h-10 w-10 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" />
          <h2 className="text-lg font-bold">Waiting for approval</h2>
          <p className="mt-1 text-sm text-stone-600">
            {tableOpen
              ? 'Someone at the table, or a member of staff, needs to let you in.'
              : 'A member of staff will confirm your table in a moment. Give them a wave.'}
          </p>
          <p className="mt-3 text-xs text-stone-500">
            Scanning the code is not enough to order. This keeps your table safe from prank orders.
          </p>
        </div>
      )}

      {denied && <Notice tone="amber">Your request was declined. Please speak to a member of staff.</Notice>}

      {!pending && !denied && !expired && (
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold">{tableOpen ? 'Join this table' : 'Welcome'}</h2>
          <p className="mt-1 text-sm text-stone-600">
            {tableOpen
              ? 'This table is already ordering. Ask to join and someone at the table will let you in.'
              : 'Tell us who you are and we will let the staff know you are seated.'}
          </p>
          <label className="mt-4 block text-sm font-medium">
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              placeholder="e.g. Ayesha"
              className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-3 text-base"
            />
          </label>
          {!tableOpen && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm font-medium">Guests at the table</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setParty((p) => Math.max(1, p - 1))}
                  className="h-11 w-11 rounded-full border border-stone-300 text-xl"
                  aria-label="Fewer guests"
                >
                  −
                </button>
                <span className="w-6 text-center text-lg font-bold">{party}</span>
                <button
                  onClick={() => setParty((p) => Math.min(view.capacity + 2, p + 1))}
                  className="h-11 w-11 rounded-full border border-stone-300 text-xl"
                  aria-label="More guests"
                >
                  +
                </button>
              </div>
            </div>
          )}
          {actionError && <div className="mt-3"><Notice>{actionError}</Notice></div>}
          <Button size="lg" className="mt-5 w-full" disabled={busy} onClick={request}>
            {busy ? 'Sending…' : tableOpen ? 'Ask to join' : 'Request to order'}
          </Button>
        </div>
      )}

      <h3 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-stone-500">Have a look at the menu</h3>
      <MenuBrowser menu={menu} />
    </Shell>
  )
}

function Shell({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-full max-w-md bg-cream">
      <header className="bg-brand-900 px-5 pb-6 pt-8 text-white">
        <p className="text-xs uppercase tracking-widest text-saffron-400">{subtitle ?? 'Table ordering'}</p>
        <h1 className="text-2xl font-bold">{title ?? 'Zaiqa Karahi House'}</h1>
      </header>
      <div className="-mt-3 rounded-t-3xl bg-cream p-4">{children}</div>
    </div>
  )
}
