import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

export const BRANCH_ID = import.meta.env.VITE_DEFAULT_BRANCH_ID as string

/**
 * Two separate clients with separate stored logins, so a staff login and a
 * guest identity can live in the same browser (handy for demos on one laptop).
 *
 * Guests are signed in anonymously: no form, but the database still knows
 * which phone is asking. Adding ?guest=2 to a guest URL gives that tab a
 * second identity, which lets one laptop play two phones at the same table.
 */
const guestSuffix = new URLSearchParams(window.location.search).get('guest') ?? ''

export const guestDb: SupabaseClient = createClient(url, key, {
  auth: { storageKey: `zaiqa-guest${guestSuffix}`, persistSession: true, autoRefreshToken: true },
})

export const staffDb: SupabaseClient = createClient(url, key, {
  auth: { storageKey: 'zaiqa-staff', persistSession: true, autoRefreshToken: true },
})

/** Makes sure this phone has an (anonymous) identity and returns its user id. */
export async function ensureGuest(): Promise<string> {
  const { data } = await guestDb.auth.getSession()
  if (data.session) return data.session.user.id
  const { data: signed, error } = await guestDb.auth.signInAnonymously()
  if (error || !signed.user) throw new Error(error?.message ?? 'Could not start a guest session')
  return signed.user.id
}

/** Asks the scheduler (edge function) to re-plan the kitchen for a branch. Never throws. */
export async function replan(db: SupabaseClient, branchId: string): Promise<void> {
  try {
    await db.functions.invoke('replan', { body: { branch_id: branchId } })
  } catch (e) {
    console.warn('replan failed', e)
  }
}

/** Keeps the guest-identity suffix (?guest=2) when building in-app links. */
export function withGuestSuffix(path: string): string {
  return guestSuffix ? `${path}${path.includes('?') ? '&' : '?'}guest=${guestSuffix}` : path
}
