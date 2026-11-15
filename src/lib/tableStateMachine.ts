/**
 * Table state machine — the TypeScript mirror of public.table_transitions.
 *
 * The database is the authority: private.transition_table() is the only code
 * that changes tables.state, and it checks the same list. This module exists
 * so the UI can decide which buttons to show, and so the rules can be unit
 * tested. tests/db.security.test.ts asserts the two lists are identical.
 */

export const TABLE_STATES = ['free', 'seated', 'ordered', 'eating', 'bill_requested', 'paid_dirty'] as const
export type TableState = (typeof TABLE_STATES)[number]

export type TableEvent =
  | 'seat'
  | 'order_placed'
  | 'guests_left'
  | 'order_served'
  | 'bill_requested'
  | 'staff_closed'
  | 'paid'
  | 'cleared'

export interface Transition {
  from: TableState
  to: TableState
  event: TableEvent
}

export const TRANSITIONS: readonly Transition[] = [
  { from: 'free', to: 'seated', event: 'seat' },
  { from: 'seated', to: 'ordered', event: 'order_placed' },
  { from: 'seated', to: 'free', event: 'guests_left' },
  { from: 'ordered', to: 'eating', event: 'order_served' },
  { from: 'eating', to: 'ordered', event: 'order_placed' },
  { from: 'eating', to: 'bill_requested', event: 'bill_requested' },
  { from: 'ordered', to: 'paid_dirty', event: 'staff_closed' },
  { from: 'eating', to: 'paid_dirty', event: 'staff_closed' },
  { from: 'bill_requested', to: 'paid_dirty', event: 'paid' },
  { from: 'paid_dirty', to: 'free', event: 'cleared' },
]

export function canTransition(from: TableState, to: TableState): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to)
}

export function nextStates(from: TableState): TableState[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.to)
}

/** Applies an event, or throws if the event is not legal in this state. */
export function applyEvent(from: TableState, event: TableEvent): TableState {
  const t = TRANSITIONS.find((x) => x.from === from && x.event === event)
  if (!t) throw new Error(`invalid_transition: ${event} is not allowed from ${from}`)
  return t.to
}

export const STATE_LABEL: Record<TableState, string> = {
  free: 'Free',
  seated: 'Seated',
  ordered: 'Ordered',
  eating: 'Eating',
  bill_requested: 'Bill requested',
  paid_dirty: 'Paid, needs cleaning',
}

/** Default minutes a table may stay in a state before the floor map flags it. */
export const DEFAULT_STATE_LIMITS_MIN: Partial<Record<TableState, number>> = {
  seated: 10,
  ordered: 40,
  eating: 75,
  bill_requested: 10,
  paid_dirty: 10,
}

/** True when a table has been in its state longer than the configured limit. */
export function isOverdue(
  state: TableState,
  stateSince: string | number | Date,
  now: number = Date.now(),
  limits: Partial<Record<string, number>> = DEFAULT_STATE_LIMITS_MIN,
): boolean {
  const limit = limits[state]
  if (limit == null) return false
  return now - new Date(stateSince).getTime() > limit * 60_000
}
