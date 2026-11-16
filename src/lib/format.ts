export const rs = (n: number) => `Rs ${Math.round(n).toLocaleString('en-PK')}`

export function minutesSince(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
}

/** "3:05" style elapsed timer. */
export function clock(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '0:00'
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Whole minutes until a time (never negative). */
export function minutesUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60000))
}

/**
 * Time zone the restaurant runs in. Times shown to guests and staff always use
 * it, never the device's zone. (One branch today; with several branches this
 * would come from branches.timezone.)
 */
export const RESTAURANT_ZONE = 'Asia/Karachi'

export const timeOfDay = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit', timeZone: RESTAURANT_ZONE })

const MESSAGES: Record<string, string> = {
  invalid_token: 'This QR code is not valid. Please ask staff for help.',
  session_not_open: 'This table is not open for ordering right now.',
  cart_empty: 'Your cart is empty.',
  item_unavailable: 'One of the dishes just became unavailable.',
  orders_in_progress: 'Your food is still being prepared. You can ask for the bill once it has been served.',
  too_many_requests: 'Too many requests from this phone. Please ask staff for help.',
  table_not_free: 'This table is not free yet.',
  invalid_transition: 'That change is not allowed for this table right now.',
  not_staff: 'You need a staff login for this.',
  not_allowed: 'You are not allowed to do this.',
  already_paid: 'This has already been paid.',
  no_table_available: 'No table is available for that time and group size.',
  party_too_large: 'We do not have a table that large. Please call us.',
  slot_must_be_later_today: 'Please pick a time later today.',
  already_reserved: 'You already have a reservation today.',
  not_offered: 'This offer is no longer open.',
  not_booked: 'This reservation is no longer active.',
  entry_not_found: 'That waitlist entry no longer exists.',
  reservation_not_found: 'That reservation no longer exists.',
  not_authenticated: 'Please reload the page and try again.',
  no_live_session: 'There is no open session at this table.',
  session_not_pending: 'This request has already been answered.',
  invalid_item_transition: 'That dish cannot move to that status from where it is.',
  'Anonymous sign-ins are disabled': 'Guest access is switched off in Supabase (enable anonymous sign-ins).',
}

/** Turns a database error code into a sentence a guest can read. */
export function friendly(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error)
  for (const code of Object.keys(MESSAGES)) if (raw.includes(code)) return MESSAGES[code]
  return raw || 'Something went wrong. Please try again.'
}

export const SPICE = ['Not spicy', 'Mild', 'Medium', 'Hot']
