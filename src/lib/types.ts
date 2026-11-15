import type { TableState } from './tableStateMachine'

export interface Branch {
  id: string
  name: string
  currency: string
  timezone: string
  tax_rate: number
  settings: { session_hours?: number; state_limits_min?: Record<string, number> }
}
export interface Station { id: string; branch_id: string; name: string; capacity: number; sort: number }
export interface MenuCategory { id: string; name: string; sort: number }
export interface MenuItem {
  id: string
  branch_id: string
  category_id: string
  station_id: string
  name: string
  description: string
  price: number
  cost: number
  prep_minutes: number
  allergens: string[]
  spice_level: number
  is_available: boolean
  sort: number
}
export interface MenuItemSize { id: string; menu_item_id: string; name: string; price: number; cost: number; prep_minutes: number | null; sort: number }
export interface Deal { id: string; menu_item_id: string; title: string; percent_off: number; start_hour: number; end_hour: number; active: boolean }

export interface TableRow {
  id: string
  branch_id: string
  label: string
  capacity: number
  pos_x: number
  pos_y: number
  shape: 'round' | 'square' | 'long'
  state: TableState
  state_since: string
}
export type SessionStatus = 'pending' | 'open' | 'closed' | 'denied' | 'expired'
export interface TableSession {
  id: string
  branch_id: string
  table_id: string
  status: SessionStatus
  party_size: number
  requested_at: string
  opened_at: string | null
  closed_at: string | null
  expires_at: string | null
}
export interface SessionGuest { id: string; session_id: string; user_id: string; display_name: string; status: 'pending' | 'approved' | 'denied' }
export interface CartItem { id: string; session_id: string; guest_id: string; menu_item_id: string; size_id: string | null; qty: number; notes: string; created_at: string }
export interface Order {
  id: string
  branch_id: string
  session_id: string | null
  table_id: string | null
  order_no: number
  status: 'open' | 'served' | 'cancelled'
  placed_at: string
  estimated_ready_at: string | null
  served_at: string | null
}
export type ItemStatus = 'queued' | 'cooking' | 'ready' | 'served' | 'cancelled'
export interface OrderItem {
  id: string
  order_id: string
  session_id: string | null
  guest_id: string | null
  station_id: string | null
  name: string
  size_name: string | null
  qty: number
  unit_price: number
  prep_minutes: number
  notes: string
  status: ItemStatus
  planned_start_at: string | null
  planned_ready_at: string | null
  started_at: string | null
  ready_at: string | null
  served_at: string | null
  created_at: string
}
export type CallReason = 'help' | 'water' | 'bill' | 'cutlery' | 'clean'
export interface WaiterCall { id: string; session_id: string; table_id: string; reason: CallReason; status: 'open' | 'acknowledged'; created_at: string }
export interface Bill { id: string; session_id: string; subtotal: number; tax: number; tip: number; total: number; split_mode: 'whole' | 'equal' | 'by_guest'; status: 'open' | 'paid' }
export interface BillShare { id: string; bill_id: string; session_id: string; guest_id: string | null; label: string; amount: number; tip: number; status: 'unpaid' | 'paid'; method: string | null }
export interface WaitlistEntry { id: string; name: string; phone: string | null; party_size: number; status: 'waiting' | 'offered' | 'seated' | 'cancelled' | 'no_show'; offered_table_id: string | null; created_at: string }
export interface Reservation { id: string; name: string; phone: string | null; party_size: number; slot_start: string; table_id: string | null; status: 'booked' | 'seated' | 'cancelled' | 'no_show' }

/** What resolve_table / request_session return. */
export interface TableView {
  table_id: string
  label: string
  capacity: number
  branch_id: string
  branch_name: string
  restaurant_name: string
  session_id: string | null
  session_status: SessionStatus | null
  guest_id: string | null
  guest_status: 'pending' | 'approved' | 'denied' | null
}
