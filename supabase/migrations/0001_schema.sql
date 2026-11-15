-- 0001_schema.sql
-- Core tables. Every operational table carries branch_id so that multiple
-- branches per restaurant can be added later without a rewrite.
-- Money is stored as whole rupees (integer). Times are timestamptz.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

-- ---------------------------------------------------------------- tenancy
create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  currency text not null default 'PKR',
  timezone text not null default 'Asia/Karachi',
  tax_rate numeric(5,4) not null default 0,
  -- state_limits_min: minutes a table may sit in a state before it is flagged
  -- session_hours: hard expiry of a table session
  settings jsonb not null default '{
    "session_hours": 4,
    "state_limits_min": {"seated": 10, "ordered": 40, "eating": 75, "bill_requested": 10, "paid_dirty": 10}
  }'::jsonb,
  created_at timestamptz not null default now()
);

create table public.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  role text not null check (role in ('owner','manager','waiter','kitchen')),
  display_name text not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- menu
create table public.stations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  capacity int not null check (capacity > 0),
  sort int not null default 0
);

create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  sort int not null default 0
);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  category_id uuid not null references public.menu_categories(id) on delete cascade,
  station_id uuid not null references public.stations(id),
  name text not null,
  description text not null default '',
  price int not null check (price >= 0),
  cost int not null default 0 check (cost >= 0),          -- ingredient cost
  prep_minutes int not null check (prep_minutes > 0),
  allergens text[] not null default '{}',
  spice_level int not null default 0 check (spice_level between 0 and 3),
  is_available boolean not null default true,              -- later: stock tracking flips this
  image_url text,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- A size replaces the base price/cost/prep time of its item.
create table public.menu_item_sizes (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  name text not null,
  price int not null check (price >= 0),
  cost int not null default 0,
  prep_minutes int,
  sort int not null default 0
);

-- Percentage deal on one item, active between two local hours of the day.
create table public.deals (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  title text not null,
  percent_off int not null check (percent_off between 1 and 90),
  start_hour int not null check (start_hour between 0 and 23),
  end_hour int not null check (end_hour between 1 and 24),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ floor
create table public.tables (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  label text not null,
  capacity int not null check (capacity > 0),
  pos_x int not null default 0,     -- floor map position, percent of width
  pos_y int not null default 0,     -- percent of height
  shape text not null default 'round' check (shape in ('round','square','long')),
  state text not null default 'free'
    check (state in ('free','seated','ordered','eating','bill_requested','paid_dirty')),
  state_since timestamptz not null default now(),
  qr_version int not null default 1,  -- bump to invalidate every printed QR for this table
  unique (branch_id, label)
);

-- Audit log of every state change. `source` leaves room for a camera or other
-- sensor to report occupancy later and be cross-checked against staff taps.
create table public.table_state_events (
  id bigint generated always as identity primary key,
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  from_state text not null,
  to_state text not null,
  actor uuid,
  source text not null default 'staff',
  created_at timestamptz not null default now()
);
create index on public.table_state_events (table_id, created_at desc);

-- --------------------------------------------------------------- sessions
create table public.table_sessions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','open','closed','denied','expired')),
  party_size int not null default 1 check (party_size between 1 and 30),
  requested_by uuid,
  opened_by uuid,
  requested_at timestamptz not null default now(),
  opened_at timestamptz,
  closed_at timestamptz,
  expires_at timestamptz
);
-- At most one live (pending or open) session per table.
create unique index table_sessions_one_live on public.table_sessions (table_id)
  where status in ('pending','open');
create index on public.table_sessions (branch_id, status);

create table public.session_guests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  user_id uuid not null,                       -- auth.users id of the (anonymous) phone
  display_name text not null check (char_length(display_name) between 1 and 30),
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  joined_at timestamptz not null default now(),
  unique (session_id, user_id)
);
create index on public.session_guests (user_id);

-- --------------------------------------------------------------- ordering
create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  guest_id uuid not null references public.session_guests(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  size_id uuid references public.menu_item_sizes(id) on delete cascade,
  qty int not null default 1 check (qty between 1 and 20),
  notes text not null default '' check (char_length(notes) <= 140),
  created_at timestamptz not null default now()
);
create index on public.cart_items (session_id);

create sequence public.order_no_seq start 1001;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  session_id uuid references public.table_sessions(id) on delete set null,
  table_id uuid references public.tables(id) on delete set null,
  order_no int not null default nextval('public.order_no_seq'),
  status text not null default 'open' check (status in ('open','served','cancelled')),
  placed_at timestamptz not null default now(),
  estimated_ready_at timestamptz,          -- written by the scheduler
  served_at timestamptz,
  is_sample boolean not null default false -- generated history, never shown as real
);
create index on public.orders (branch_id, status);
create index on public.orders (session_id);
create index on public.orders (branch_id, placed_at);

-- One row per unit to cook (a quantity of 3 becomes three rows), because each
-- unit occupies one slot of station capacity. Price, cost and prep time are
-- snapshotted so later menu edits do not rewrite history.
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  session_id uuid references public.table_sessions(id) on delete set null,
  guest_id uuid references public.session_guests(id) on delete set null,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  station_id uuid references public.stations(id) on delete set null,
  name text not null,
  size_name text,
  qty int not null default 1 check (qty > 0),
  unit_price int not null,
  unit_cost int not null default 0,
  prep_minutes int not null,
  notes text not null default '',
  status text not null default 'queued'
    check (status in ('queued','cooking','ready','served','cancelled')),
  planned_start_at timestamptz,            -- written by the scheduler
  planned_ready_at timestamptz,            -- written by the scheduler
  started_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  created_at timestamptz not null default now(),
  is_sample boolean not null default false
);
create index on public.order_items (order_id);
create index on public.order_items (branch_id, status);
create index on public.order_items (session_id);

-- ---------------------------------------------------------------- service
create table public.waiter_calls (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  reason text not null check (reason in ('help','water','bill','cutlery','clean')),
  status text not null default 'open' check (status in ('open','acknowledged')),
  created_by uuid,
  created_at timestamptz not null default now(),
  acked_by uuid,
  acked_at timestamptz
);
create index on public.waiter_calls (branch_id, status);

-- ---------------------------------------------------------------- billing
create table public.bills (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  session_id uuid not null unique references public.table_sessions(id) on delete cascade,
  subtotal int not null,
  tax int not null default 0,
  tip int not null default 0,
  total int not null,
  split_mode text not null default 'whole' check (split_mode in ('whole','equal','by_guest')),
  status text not null default 'open' check (status in ('open','paid')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table public.bill_shares (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  guest_id uuid references public.session_guests(id) on delete set null,
  label text not null,
  amount int not null,          -- food + tax
  tip int not null default 0,
  status text not null default 'unpaid' check (status in ('unpaid','paid')),
  method text,
  paid_at timestamptz
);
create index on public.bill_shares (session_id);

-- `provider` and `provider_ref` are where JazzCash / Easypaisa / Raast will
-- plug in later. Today every row is simulated.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  share_id uuid references public.bill_shares(id) on delete set null,
  amount int not null,
  method text not null,
  provider text not null default 'simulated',
  provider_ref text,
  is_simulated boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  guest_id uuid not null references public.session_guests(id) on delete cascade,
  stars int not null check (stars between 1 and 5),
  comment text not null default '' check (char_length(comment) <= 300),
  created_at timestamptz not null default now(),
  unique (session_id, guest_id)
);

-- ------------------------------------------------------------------ queue
create table public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  user_id uuid,                               -- null when staff add a walk-in
  name text not null check (char_length(name) between 1 and 40),
  phone text,
  party_size int not null check (party_size between 1 and 30),
  status text not null default 'waiting'
    check (status in ('waiting','offered','seated','cancelled','no_show')),
  offered_table_id uuid references public.tables(id) on delete set null,
  offered_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.waitlist_entries (branch_id, status, created_at);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  user_id uuid,
  name text not null check (char_length(name) between 1 and 40),
  phone text,
  party_size int not null check (party_size between 1 and 30),
  slot_start timestamptz not null,
  table_id uuid references public.tables(id) on delete set null,
  status text not null default 'booked'
    check (status in ('booked','seated','cancelled','no_show')),
  created_at timestamptz not null default now()
);
create index on public.reservations (branch_id, slot_start);

-- ---------------------------------------------------------------- private
-- HMAC secret used to sign table QR tokens. The `private` schema is not
-- exposed through the API, so the browser can never read it.
create table private.qr_keys (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  secret text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
