-- 0002_state_machine_and_rls.sql
-- 1. The table state machine: one table of legal transitions, one function
--    that performs them, and a trigger that blocks every other write to
--    tables.state.
-- 2. Helper functions used by row-level security.
-- 3. Row-level security policies and grants.

-- =============================================================== state machine
create table public.table_transitions (
  from_state text not null,
  to_state text not null,
  event text not null,
  primary key (from_state, to_state)
);

insert into public.table_transitions (from_state, to_state, event) values
  ('free',           'seated',         'seat'),            -- staff seat guests / approve a scan
  ('seated',         'ordered',        'order_placed'),    -- first order
  ('seated',         'free',           'guests_left'),     -- seated but left without ordering
  ('ordered',        'eating',         'order_served'),    -- kitchen marks everything served
  ('eating',         'ordered',        'order_placed'),    -- a second round
  ('eating',         'bill_requested', 'bill_requested'),  -- guest taps pay
  ('ordered',        'paid_dirty',     'staff_closed'),    -- settled at the counter
  ('eating',         'paid_dirty',     'staff_closed'),
  ('bill_requested', 'paid_dirty',     'paid'),            -- payment completes
  ('paid_dirty',     'free',           'cleared');         -- staff tap "table cleared"

-- Block direct writes to tables.state. Only private.transition_table sets the
-- transaction-local flag that lets the update through.
create function private.guard_table_state() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.state is distinct from old.state
     and coalesce(current_setting('app.state_transition', true), '') <> 'on' then
    raise exception 'table state can only change through transition_table'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger guard_table_state before update on public.tables
  for each row execute function private.guard_table_state();

-- The single place a table changes state.
create function private.transition_table(p_table uuid, p_to text, p_source text default 'staff')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_branch uuid;
begin
  select state, branch_id into v_from, v_branch
    from public.tables where id = p_table for update;
  if not found then
    raise exception 'table_not_found' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.table_transitions
                  where from_state = v_from and to_state = p_to) then
    raise exception 'invalid_transition: % -> %', v_from, p_to using errcode = 'P0001';
  end if;

  perform set_config('app.state_transition', 'on', true);
  update public.tables set state = p_to, state_since = now() where id = p_table;
  perform set_config('app.state_transition', 'off', true);

  insert into public.table_state_events (branch_id, table_id, from_state, to_state, actor, source)
  values (v_branch, p_table, v_from, p_to, auth.uid(), p_source);
end $$;

-- ================================================================== helpers
create function private.staff_role(p_branch uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.staff_members
   where user_id = auth.uid() and branch_id = p_branch
$$;

create function private.is_staff(p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_members
                  where user_id = auth.uid() and branch_id = p_branch)
$$;

create function private.is_manager(p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_members
                  where user_id = auth.uid() and branch_id = p_branch
                    and role in ('owner','manager'))
$$;

-- The caller's guest row in a session (any status).
create function private.has_guest_row(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.session_guests
                  where session_id = p_session and user_id = auth.uid())
$$;

-- The caller is an approved guest of the session.
create function private.is_member(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.session_guests
                  where session_id = p_session and user_id = auth.uid()
                    and status = 'approved')
$$;

create function private.my_guest_id(p_session uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.session_guests
   where session_id = p_session and user_id = auth.uid() and status = 'approved'
$$;

-- The rule every ordering path checks: the caller is an approved guest of a
-- session that is open, not expired, and whose table is still taking orders.
create function private.can_order(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.table_sessions s
      join public.tables t on t.id = s.table_id
      join public.session_guests g on g.session_id = s.id
     where s.id = p_session
       and s.status = 'open'
       and s.expires_at > now()
       and t.state in ('seated','ordered','eating')
       and g.user_id = auth.uid()
       and g.status = 'approved')
$$;

grant usage on schema private to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.staff_role(uuid), private.is_staff(uuid), private.is_manager(uuid),
  private.has_guest_row(uuid), private.is_member(uuid), private.my_guest_id(uuid),
  private.can_order(uuid)
to authenticated;

-- Cart rows: never trust branch_id from the browser, and refuse dishes that are
-- unavailable or belong to another branch.
create function private.cart_items_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
begin
  select branch_id into v_branch from public.table_sessions where id = new.session_id;
  new.branch_id := v_branch;
  if not exists (select 1 from public.menu_items m
                  where m.id = new.menu_item_id and m.branch_id = v_branch and m.is_available) then
    raise exception 'item_unavailable' using errcode = 'P0001';
  end if;
  if new.size_id is not null and not exists (
       select 1 from public.menu_item_sizes z
        where z.id = new.size_id and z.menu_item_id = new.menu_item_id) then
    raise exception 'invalid_size' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger cart_items_before_write before insert or update on public.cart_items
  for each row execute function private.cart_items_before_write();

-- ====================================================================== RLS
alter table public.restaurants        enable row level security;
alter table public.branches           enable row level security;
alter table public.staff_members      enable row level security;
alter table public.stations           enable row level security;
alter table public.menu_categories    enable row level security;
alter table public.menu_items         enable row level security;
alter table public.menu_item_sizes    enable row level security;
alter table public.deals              enable row level security;
alter table public.tables             enable row level security;
alter table public.table_transitions  enable row level security;
alter table public.table_state_events enable row level security;
alter table public.table_sessions     enable row level security;
alter table public.session_guests     enable row level security;
alter table public.cart_items         enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.waiter_calls       enable row level security;
alter table public.bills              enable row level security;
alter table public.bill_shares        enable row level security;
alter table public.payments           enable row level security;
alter table public.ratings            enable row level security;
alter table public.waitlist_entries   enable row level security;
alter table public.reservations       enable row level security;

-- Start from nothing, then grant exactly what each role needs. The `anon`
-- role (no login at all) gets no access: guests are signed in anonymously and
-- therefore run as `authenticated` with their own user id.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.cart_items to authenticated;
grant insert, update, delete on
  public.menu_categories, public.menu_items, public.menu_item_sizes,
  public.deals, public.stations to authenticated;
grant update on public.tables, public.branches to authenticated;

-- Public reference data: anyone signed in (guest or staff) can read the menu.
create policy read_all on public.restaurants       for select to authenticated using (true);
create policy read_all on public.branches          for select to authenticated using (true);
create policy read_all on public.stations          for select to authenticated using (true);
create policy read_all on public.menu_categories   for select to authenticated using (true);
create policy read_all on public.menu_items        for select to authenticated using (true);
create policy read_all on public.menu_item_sizes   for select to authenticated using (true);
create policy read_all on public.deals             for select to authenticated using (true);
create policy read_all on public.table_transitions for select to authenticated using (true);

-- Menu editing: owner or manager of the branch.
create policy manage on public.menu_categories for all to authenticated
  using (private.is_manager(branch_id)) with check (private.is_manager(branch_id));
create policy manage on public.menu_items for all to authenticated
  using (private.is_manager(branch_id)) with check (private.is_manager(branch_id));
create policy manage on public.deals for all to authenticated
  using (private.is_manager(branch_id)) with check (private.is_manager(branch_id));
create policy manage on public.stations for all to authenticated
  using (private.is_manager(branch_id)) with check (private.is_manager(branch_id));
create policy manage on public.menu_item_sizes for all to authenticated
  using (exists (select 1 from public.menu_items m
                  where m.id = menu_item_id and private.is_manager(m.branch_id)))
  with check (exists (select 1 from public.menu_items m
                  where m.id = menu_item_id and private.is_manager(m.branch_id)));
create policy manage on public.branches for update to authenticated
  using (private.is_manager(id)) with check (private.is_manager(id));
-- Layout edits only; the guard trigger still blocks state changes.
create policy manage on public.tables for update to authenticated
  using (private.is_manager(branch_id)) with check (private.is_manager(branch_id));

-- Staff see everything in their branch.
create policy staff_read on public.staff_members for select to authenticated
  using (user_id = auth.uid() or private.is_staff(branch_id));
create policy staff_read on public.tables for select to authenticated
  using (private.is_staff(branch_id));
create policy staff_read on public.table_state_events for select to authenticated
  using (private.is_staff(branch_id));
create policy staff_read on public.payments for select to authenticated
  using (private.is_staff(branch_id));

-- Sessions and everything hanging off them: staff of the branch, or guests of
-- that session. A guest who is still pending can see only the session row and
-- their own guest row (to learn whether they were approved).
create policy read on public.table_sessions for select to authenticated
  using (private.is_staff(branch_id) or private.has_guest_row(id));
create policy read on public.session_guests for select to authenticated
  using (private.is_staff(branch_id) or user_id = auth.uid() or private.is_member(session_id));
create policy read on public.cart_items for select to authenticated
  using (private.is_staff(branch_id) or private.is_member(session_id));
create policy read on public.orders for select to authenticated
  using (private.is_staff(branch_id) or private.is_member(session_id));
create policy read on public.order_items for select to authenticated
  using (private.is_staff(branch_id) or private.is_member(session_id));
create policy read on public.waiter_calls for select to authenticated
  using (private.is_staff(branch_id) or private.is_member(session_id));
create policy read on public.bills for select to authenticated
  using (private.is_staff(branch_id) or private.is_member(session_id));
create policy read on public.bill_shares for select to authenticated
  using (private.is_staff(branch_id) or private.is_member(session_id));
create policy read on public.ratings for select to authenticated
  using (private.is_staff(branch_id) or private.is_member(session_id));
create policy read on public.waitlist_entries for select to authenticated
  using (private.is_staff(branch_id) or user_id = auth.uid());
create policy read on public.reservations for select to authenticated
  using (private.is_staff(branch_id) or user_id = auth.uid());

-- The shared cart is the one thing guests write directly. A guest can add,
-- change and remove only their own lines, and only while can_order() holds.
create policy guest_insert on public.cart_items for insert to authenticated
  with check (private.can_order(session_id) and guest_id = private.my_guest_id(session_id));
create policy guest_update on public.cart_items for update to authenticated
  using (private.can_order(session_id) and guest_id = private.my_guest_id(session_id))
  with check (private.can_order(session_id) and guest_id = private.my_guest_id(session_id));
create policy guest_delete on public.cart_items for delete to authenticated
  using (private.can_order(session_id) and guest_id = private.my_guest_id(session_id));

-- orders, order_items, bills, bill_shares, payments, waiter_calls, sessions,
-- guests, ratings, waitlist and reservations have NO insert/update/delete
-- policy and no write grant: they change only through the functions in 0003.

-- ================================================================= realtime
alter publication supabase_realtime add table
  public.tables, public.table_sessions, public.session_guests, public.cart_items,
  public.orders, public.order_items, public.waiter_calls, public.bills,
  public.bill_shares, public.waitlist_entries, public.reservations,
  public.menu_items;
