-- 0003_functions.sql
-- Every write that matters goes through one of these functions. They run as
-- SECURITY DEFINER (with an empty search_path) and check the caller themselves,
-- so the rules cannot be bypassed from a browser console.
-- Errors are raised as short machine-readable codes, e.g. 'session_not_open'.

-- ================================================================ QR tokens
-- token = <table uuid, no dashes>.<qr_version>.<first 32 hex chars of
--          HMAC-SHA256(table uuid || '.' || version, branch secret)>
create function private.sign_table(p_table uuid, p_version int) returns text
language sql stable security definer set search_path = '' as $$
  select replace(t.id::text, '-', '') || '.' || p_version || '.' ||
         substr(encode(extensions.hmac(t.id::text || '.' || p_version, k.secret, 'sha256'), 'hex'), 1, 32)
    from public.tables t
    join private.qr_keys k on k.branch_id = t.branch_id
   where t.id = p_table
$$;

-- Returns the table id for a valid token, raises 'invalid_token' otherwise.
create function private.verify_table_token(p_token text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_table uuid;
  v_version int;
begin
  begin
    v_table := split_part(p_token, '.', 1)::uuid;
    v_version := split_part(p_token, '.', 2)::int;
  exception when others then
    raise exception 'invalid_token' using errcode = 'P0001';
  end;
  if not exists (select 1 from public.tables where id = v_table and qr_version = v_version)
     or private.sign_table(v_table, v_version) is distinct from p_token then
    raise exception 'invalid_token' using errcode = 'P0001';
  end if;
  return v_table;
end $$;

create function private.require_staff(p_branch uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_staff(p_branch) then
    raise exception 'not_staff' using errcode = 'P0001';
  end if;
end $$;

-- What a phone is told about a table and its own standing there.
create function private.table_view(p_table uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'table_id', t.id, 'label', t.label, 'capacity', t.capacity,
    'branch_id', b.id, 'branch_name', b.name, 'restaurant_name', r.name,
    'session_id', s.id,
    'session_status', case when s.status = 'open' and s.expires_at <= now() then 'expired' else s.status end,
    'guest_id', g.id, 'guest_status', g.status)
    from public.tables t
    join public.branches b on b.id = t.branch_id
    join public.restaurants r on r.id = b.restaurant_id
    left join public.table_sessions s on s.table_id = t.id and s.status in ('pending','open')
    left join public.session_guests g on g.session_id = s.id and g.user_id = auth.uid()
   where t.id = p_table
$$;

-- ============================================================ guest: sessions
create function public.resolve_table(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return private.table_view(private.verify_table_token(p_token));
end $$;

-- A scan never opens a session by itself. It files a request that staff (or,
-- once the table is open, someone already seated there) must approve.
create function public.request_session(p_token text, p_name text, p_party_size int default 2)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_table uuid := private.verify_table_token(p_token);
  v_branch uuid;
  v_session uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  select branch_id into v_branch from public.tables where id = v_table for update;

  -- throttle: three refusals in an hour and the phone has to wait
  if (select count(*) from public.session_guests
       where user_id = v_uid and status = 'denied'
         and joined_at > now() - interval '1 hour') >= 3 then
    raise exception 'too_many_requests' using errcode = 'P0001';
  end if;

  select id into v_session from public.table_sessions
   where table_id = v_table and status in ('pending','open');
  if v_session is null then
    insert into public.table_sessions (branch_id, table_id, status, party_size, requested_by)
    values (v_branch, v_table, 'pending', greatest(1, least(coalesce(p_party_size, 2), 30)), v_uid)
    returning id into v_session;
  end if;

  insert into public.session_guests (session_id, branch_id, user_id, display_name, status)
  values (v_session, v_branch, v_uid, left(coalesce(nullif(trim(p_name), ''), 'Guest'), 30), 'pending')
  on conflict (session_id, user_id) do nothing;

  return private.table_view(v_table);
end $$;

-- Opens a session on a table and moves it to 'seated'. Shared by every path
-- that seats people (approve scan, walk-in, waitlist offer, reservation).
create function private.open_session(p_table uuid, p_party int, p_user uuid, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_state text;
  v_hours numeric;
  v_session uuid;
begin
  select t.branch_id, t.state, coalesce((b.settings->>'session_hours')::numeric, 4)
    into v_branch, v_state, v_hours
    from public.tables t join public.branches b on b.id = t.branch_id
   where t.id = p_table for update of t;
  if v_state = 'paid_dirty' then
    perform private.transition_table(p_table, 'free');
    v_state := 'free';
  end if;
  if v_state <> 'free' then
    raise exception 'table_not_free' using errcode = 'P0001';
  end if;

  select id into v_session from public.table_sessions
   where table_id = p_table and status = 'pending';
  if v_session is null then
    insert into public.table_sessions (branch_id, table_id, status, party_size, requested_by)
    values (v_branch, p_table, 'pending', greatest(1, coalesce(p_party, 2)), p_user)
    returning id into v_session;
  end if;
  update public.table_sessions
     set status = 'open', opened_by = auth.uid(), opened_at = now(),
         expires_at = now() + make_interval(mins => (v_hours * 60)::int)
   where id = v_session;
  update public.session_guests set status = 'approved'
   where session_id = v_session and status = 'pending';
  if p_user is not null then
    insert into public.session_guests (session_id, branch_id, user_id, display_name, status)
    values (v_session, v_branch, p_user, left(coalesce(p_name, 'Guest'), 30), 'approved')
    on conflict (session_id, user_id) do update set status = 'approved';
  end if;
  perform private.transition_table(p_table, 'seated');
  return v_session;
end $$;

-- Staff answer a scan request.
create function public.staff_decide_session(p_session uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.table_sessions;
begin
  select * into s from public.table_sessions where id = p_session for update;
  if not found then raise exception 'session_not_found' using errcode = 'P0001'; end if;
  perform private.require_staff(s.branch_id);
  if s.status <> 'pending' then
    raise exception 'session_not_pending' using errcode = 'P0001';
  end if;
  if p_approve then
    perform private.open_session(s.table_id, s.party_size, null, null);
  else
    update public.table_sessions set status = 'denied', closed_at = now() where id = p_session;
    update public.session_guests set status = 'denied' where session_id = p_session;
  end if;
end $$;

-- Staff seat a walk-in without any scan.
create function public.staff_seat_table(p_table uuid, p_party_size int default 2)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff((select branch_id from public.tables where id = p_table));
  return private.open_session(p_table, p_party_size, null, null);
end $$;

-- A later phone asks to join an open table: staff or anyone already seated
-- there can let them in.
create function public.decide_guest(p_guest uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  g public.session_guests;
begin
  select * into g from public.session_guests where id = p_guest for update;
  if not found then raise exception 'guest_not_found' using errcode = 'P0001'; end if;
  if not (private.is_staff(g.branch_id) or private.is_member(g.session_id)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.table_sessions
                  where id = g.session_id and status = 'open' and expires_at > now()) then
    raise exception 'session_not_open' using errcode = 'P0001';
  end if;
  update public.session_guests
     set status = case when p_approve then 'approved' else 'denied' end
   where id = p_guest and status = 'pending';
end $$;

-- ============================================================ guest: ordering
-- Price of a dish right now, with the best active deal applied.
create function private.item_price(p_item uuid, p_size uuid) returns int
language sql stable security definer set search_path = '' as $$
  select round(coalesce(z.price, m.price) * (100 - coalesce((
           select max(d.percent_off) from public.deals d
            where d.menu_item_id = m.id and d.active
              and extract(hour from now() at time zone b.timezone) >= d.start_hour
              and extract(hour from now() at time zone b.timezone) <  d.end_hour), 0)) / 100.0)::int
    from public.menu_items m
    join public.branches b on b.id = m.branch_id
    left join public.menu_item_sizes z on z.id = p_size and z.menu_item_id = m.id
   where m.id = p_item
$$;

-- Turns the shared cart into an order. This is the function the security
-- model exists to protect: it refuses unless can_order() holds for the caller.
create function public.place_order(p_session uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.table_sessions;
  v_order uuid;
  v_state text;
begin
  if not private.can_order(p_session) then
    raise exception 'session_not_open' using errcode = 'P0001';
  end if;
  -- serialise two phones pressing "place order" at once
  select * into s from public.table_sessions where id = p_session for update;
  if not exists (select 1 from public.cart_items where session_id = p_session) then
    raise exception 'cart_empty' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cart_items c join public.menu_items m on m.id = c.menu_item_id
              where c.session_id = p_session and not m.is_available) then
    raise exception 'item_unavailable' using errcode = 'P0001';
  end if;

  insert into public.orders (branch_id, session_id, table_id)
  values (s.branch_id, s.id, s.table_id) returning id into v_order;

  insert into public.order_items
    (order_id, branch_id, session_id, guest_id, menu_item_id, station_id, name, size_name,
     qty, unit_price, unit_cost, prep_minutes, notes)
  select v_order, s.branch_id, s.id, c.guest_id, m.id, m.station_id, m.name, z.name,
         1, private.item_price(m.id, z.id), coalesce(z.cost, m.cost),
         coalesce(z.prep_minutes, m.prep_minutes), c.notes
    from public.cart_items c
    join public.menu_items m on m.id = c.menu_item_id
    left join public.menu_item_sizes z on z.id = c.size_id
    cross join generate_series(1, c.qty)
   where c.session_id = p_session
   order by c.created_at;

  delete from public.cart_items where session_id = p_session;

  select state into v_state from public.tables where id = s.table_id;
  if v_state in ('seated','eating') then
    perform private.transition_table(s.table_id, 'ordered', 'guest');
  end if;
  return v_order;
end $$;

create function public.call_waiter(p_session uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.table_sessions;
  v_call uuid;
begin
  select * into s from public.table_sessions where id = p_session;
  if not private.is_member(p_session) or s.status <> 'open' or s.expires_at <= now() then
    raise exception 'session_not_open' using errcode = 'P0001';
  end if;
  select id into v_call from public.waiter_calls
   where session_id = p_session and reason = p_reason and status = 'open';
  if v_call is null then
    insert into public.waiter_calls (branch_id, session_id, table_id, reason, created_by)
    values (s.branch_id, s.id, s.table_id, p_reason, auth.uid()) returning id into v_call;
  end if;
  return v_call;
end $$;

create function public.staff_ack_call(p_call uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff((select branch_id from public.waiter_calls where id = p_call));
  update public.waiter_calls
     set status = 'acknowledged', acked_by = auth.uid(), acked_at = now()
   where id = p_call and status = 'open';
end $$;

-- ================================================================== kitchen
-- After any item changes: close finished orders, and move the table to
-- 'eating' once nothing is left to cook or carry.
create function private.after_item_change(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if o.status = 'open' and not exists (
       select 1 from public.order_items
        where order_id = p_order and status in ('queued','cooking','ready')) then
    update public.orders
       set status = case when exists (select 1 from public.order_items
                                       where order_id = p_order and status = 'served')
                         then 'served' else 'cancelled' end,
           served_at = now()
     where id = p_order;
    if o.table_id is not null
       and not exists (select 1 from public.orders
                        where session_id = o.session_id and status = 'open')
       and (select state from public.tables where id = o.table_id) = 'ordered' then
      perform private.transition_table(o.table_id, 'eating', 'kitchen');
    end if;
  end if;
end $$;

create function public.kitchen_set_item_status(p_item uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.order_items;
begin
  select * into i from public.order_items where id = p_item for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0001'; end if;
  perform private.require_staff(i.branch_id);
  if not ((i.status, p_status) in (
       ('queued','cooking'), ('cooking','ready'), ('ready','served'),
       ('cooking','queued'), ('ready','cooking'),
       ('queued','cancelled'), ('cooking','cancelled'))) then
    raise exception 'invalid_item_transition: % -> %', i.status, p_status using errcode = 'P0001';
  end if;
  update public.order_items set
    status = p_status,
    started_at = case p_status when 'cooking' then coalesce(started_at, now())
                               when 'queued' then null else started_at end,
    ready_at   = case p_status when 'ready' then now()
                               when 'cooking' then null else ready_at end,
    served_at  = case p_status when 'served' then now() else served_at end
  where id = p_item;
  perform private.after_item_change(i.order_id);
end $$;

-- Carry out everything that is ready for one order.
create function public.kitchen_serve_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff((select branch_id from public.orders where id = p_order));
  update public.order_items set status = 'served', served_at = now()
   where order_id = p_order and status = 'ready';
  perform private.after_item_change(p_order);
end $$;

-- Written by the scheduler (edge function, service role) or by staff.
-- p_items: [{"id": uuid, "start": iso, "ready": iso}], p_orders: [{"id": uuid, "ready": iso}]
create function public.apply_schedule(p_branch uuid, p_items jsonb, p_orders jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not private.is_staff(p_branch) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  update public.order_items i
     set planned_start_at = x.start, planned_ready_at = x.ready
    from jsonb_to_recordset(p_items) as x(id uuid, start timestamptz, ready timestamptz)
   where i.id = x.id and i.branch_id = p_branch
     and (i.planned_start_at is distinct from x.start or i.planned_ready_at is distinct from x.ready);
  update public.orders o
     set estimated_ready_at = x.ready
    from jsonb_to_recordset(p_orders) as x(id uuid, ready timestamptz)
   where o.id = x.id and o.branch_id = p_branch
     and o.estimated_ready_at is distinct from x.ready;
end $$;

-- ================================================================== billing
-- Rebuilds the unpaid shares of a bill for a split mode and tip.
create function private.build_shares(p_bill uuid, p_mode text, p_tip int, p_payer uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b public.bills;
  v_due int;
  v_fix uuid;
begin
  select * into b from public.bills where id = p_bill for update;
  v_due := b.subtotal + b.tax;
  delete from public.bill_shares where bill_id = p_bill;

  if p_mode = 'equal' then
    insert into public.bill_shares (bill_id, branch_id, session_id, guest_id, label, amount, tip)
    select b.id, b.branch_id, b.session_id, g.id, g.display_name,
           v_due / count(*) over (), p_tip / count(*) over ()
      from public.session_guests g
     where g.session_id = b.session_id and g.status = 'approved';
  elsif p_mode = 'by_guest' then
    insert into public.bill_shares (bill_id, branch_id, session_id, guest_id, label, amount, tip)
    select b.id, b.branch_id, b.session_id, g.id, g.display_name,
           (v_due::bigint * x.sub / b.subtotal)::int, (p_tip::bigint * x.sub / b.subtotal)::int
      from (select guest_id, sum(unit_price * qty) as sub
              from public.order_items
             where session_id = b.session_id and status <> 'cancelled' and guest_id is not null
             group by guest_id) x
      join public.session_guests g on g.id = x.guest_id
     where b.subtotal > 0;
  end if;

  if not exists (select 1 from public.bill_shares where bill_id = p_bill) then
    p_mode := 'whole';
    insert into public.bill_shares (bill_id, branch_id, session_id, guest_id, label, amount, tip)
    values (b.id, b.branch_id, b.session_id, p_payer, 'Whole bill', v_due, p_tip);
  end if;

  -- integer division leaves a few rupees over: put them on the largest share
  select id into v_fix from public.bill_shares where bill_id = p_bill
   order by amount desc, id limit 1;
  update public.bill_shares
     set amount = amount + v_due - (select sum(amount) from public.bill_shares where bill_id = p_bill),
         tip    = tip + p_tip - (select sum(tip) from public.bill_shares where bill_id = p_bill)
   where id = v_fix;

  update public.bills set split_mode = p_mode, tip = p_tip, total = v_due + p_tip where id = p_bill;
end $$;

-- Guest taps "pay": creates the bill and moves the table to bill_requested.
create function public.request_bill(p_session uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.table_sessions;
  v_bill uuid;
  v_sub int;
  v_tax int;
  v_state text;
begin
  select * into s from public.table_sessions where id = p_session for update;
  if not found or not (private.is_member(p_session) or private.is_staff(s.branch_id)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select id into v_bill from public.bills where session_id = p_session;
  if v_bill is not null then return v_bill; end if;
  if s.status <> 'open' then
    raise exception 'session_not_open' using errcode = 'P0001';
  end if;
  select state into v_state from public.tables where id = s.table_id;
  if v_state <> 'eating' then
    raise exception 'orders_in_progress' using errcode = 'P0001';
  end if;

  select coalesce(sum(unit_price * qty), 0) into v_sub
    from public.order_items where session_id = p_session and status <> 'cancelled';
  select round(v_sub * tax_rate)::int into v_tax from public.branches where id = s.branch_id;

  insert into public.bills (branch_id, session_id, subtotal, tax, total)
  values (s.branch_id, p_session, v_sub, v_tax, v_sub + v_tax) returning id into v_bill;
  perform private.build_shares(v_bill, 'whole', 0, private.my_guest_id(p_session));
  perform private.transition_table(s.table_id, 'bill_requested', 'guest');
  return v_bill;
end $$;

create function public.set_bill_split(p_session uuid, p_mode text, p_tip_percent int)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b public.bills;
begin
  select * into b from public.bills where session_id = p_session for update;
  if not found or not private.is_member(p_session) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if b.status = 'paid' or exists (select 1 from public.bill_shares
                                   where bill_id = b.id and status = 'paid') then
    raise exception 'already_paid' using errcode = 'P0001';
  end if;
  if p_mode not in ('whole','equal','by_guest') or p_tip_percent not between 0 and 30 then
    raise exception 'invalid_split' using errcode = 'P0001';
  end if;
  perform private.build_shares(b.id, p_mode, round(b.subtotal * p_tip_percent / 100.0)::int,
                               private.my_guest_id(p_session));
end $$;

-- Closes the session and frees the table for cleaning once a bill is settled.
create function private.close_session(p_session uuid, p_to text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.table_sessions;
begin
  select * into s from public.table_sessions where id = p_session for update;
  update public.table_sessions set status = 'closed', closed_at = now() where id = p_session;
  delete from public.cart_items where session_id = p_session;
  update public.waiter_calls set status = 'acknowledged', acked_at = now()
   where session_id = p_session and status = 'open';
  update public.session_guests set status = 'denied'
   where session_id = p_session and status = 'pending';
  perform private.transition_table(s.table_id, p_to);
end $$;

-- SIMULATED payment. No money moves and no provider is contacted. When the
-- last share is paid the session closes, which is what kills ordering.
create function public.pay_share(p_share uuid, p_method text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  sh public.bill_shares;
begin
  select * into sh from public.bill_shares where id = p_share for update;
  if not found or not (private.is_member(sh.session_id) or private.is_staff(sh.branch_id)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if sh.status = 'paid' then
    raise exception 'already_paid' using errcode = 'P0001';
  end if;
  if p_method not in ('cash','card','bank_transfer','jazzcash','easypaisa','raast') then
    raise exception 'invalid_method' using errcode = 'P0001';
  end if;
  update public.bill_shares set status = 'paid', method = p_method, paid_at = now()
   where id = p_share;
  insert into public.payments (branch_id, bill_id, share_id, amount, method, provider, is_simulated)
  values (sh.branch_id, sh.bill_id, sh.id, sh.amount + sh.tip, p_method, 'simulated', true);

  if not exists (select 1 from public.bill_shares
                  where bill_id = sh.bill_id and status = 'unpaid') then
    update public.bills set status = 'paid', paid_at = now() where id = sh.bill_id;
    perform private.close_session(sh.session_id, 'paid_dirty');
  end if;
end $$;

create function public.submit_rating(p_session uuid, p_stars int, p_comment text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_guest uuid := private.my_guest_id(p_session);
begin
  if v_guest is null then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  insert into public.ratings (branch_id, session_id, guest_id, stars, comment)
  select branch_id, p_session, v_guest, p_stars, left(coalesce(p_comment, ''), 300)
    from public.table_sessions where id = p_session
  on conflict (session_id, guest_id)
  do update set stars = excluded.stars, comment = excluded.comment;
end $$;

-- ============================================================ staff: floor
-- Offer a free table to the first waiting group that fits. A table with a
-- reservation in the next hour is held back.
create function private.offer_table(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.tables;
  v_entry uuid;
begin
  select * into t from public.tables where id = p_table;
  if t.state <> 'free'
     or exists (select 1 from public.waitlist_entries
                 where offered_table_id = p_table and status = 'offered')
     or exists (select 1 from public.reservations
                 where table_id = p_table and status = 'booked'
                   and slot_start between now() - interval '15 minutes' and now() + interval '60 minutes') then
    return;
  end if;
  select id into v_entry from public.waitlist_entries
   where branch_id = t.branch_id and status = 'waiting' and party_size <= t.capacity
   order by created_at limit 1 for update skip locked;
  if v_entry is not null then
    update public.waitlist_entries
       set status = 'offered', offered_table_id = p_table, offered_at = now()
     where id = v_entry;
  end if;
end $$;

-- "Table cleared": paid_dirty -> free, then look at the waitlist.
create function public.staff_clear_table(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_staff((select branch_id from public.tables where id = p_table));
  perform private.transition_table(p_table, 'free');
  perform private.offer_table(p_table);
end $$;

-- Staff end a session by hand: guests left before ordering, or paid at the
-- counter. The state machine decides whether that is legal.
create function public.staff_close_table(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.tables;
  v_session uuid;
begin
  select * into t from public.tables where id = p_table for update;
  perform private.require_staff(t.branch_id);
  select id into v_session from public.table_sessions
   where table_id = p_table and status in ('pending','open');
  if v_session is null then
    raise exception 'no_live_session' using errcode = 'P0001';
  end if;
  if t.state in ('free','paid_dirty') then  -- only a pending scan request: refuse it
    update public.table_sessions set status = 'denied', closed_at = now() where id = v_session;
    update public.session_guests set status = 'denied' where session_id = v_session;
    return;
  end if;
  update public.order_items set status = 'cancelled'
   where session_id = v_session and status in ('queued','cooking');
  update public.orders set status = 'served', served_at = now()
   where session_id = v_session and status = 'open';
  perform private.close_session(v_session, case when t.state = 'seated' then 'free' else 'paid_dirty' end);
  if t.state = 'seated' then perform private.offer_table(p_table); end if;
end $$;

-- Tokens for printing QR codes.
create function public.staff_table_tokens(p_branch uuid)
returns table (table_id uuid, label text, capacity int, token text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_staff(p_branch);
  return query
    select t.id, t.label, t.capacity, private.sign_table(t.id, t.qr_version)
      from public.tables t where t.branch_id = p_branch order by t.label;
end $$;

-- Invalidate every printed copy of one table's QR code.
create function public.staff_rotate_qr(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_manager((select branch_id from public.tables where id = p_table)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  update public.tables set qr_version = qr_version + 1 where id = p_table;
end $$;

-- ================================================================= waitlist
create function public.join_waitlist(p_branch uuid, p_name text, p_party_size int, p_phone text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_staff boolean := private.is_staff(p_branch);
  v_table uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  if not v_staff then
    select id into v_id from public.waitlist_entries
     where user_id = v_uid and branch_id = p_branch and status in ('waiting','offered');
    if v_id is not null then return v_id; end if;
  end if;
  insert into public.waitlist_entries (branch_id, user_id, name, phone, party_size)
  values (p_branch, case when v_staff then null else v_uid end,
          left(coalesce(nullif(trim(p_name), ''), 'Guest'), 40), nullif(trim(p_phone), ''), p_party_size)
  returning id into v_id;
  -- a table may already be standing free
  for v_table in select id from public.tables
                  where branch_id = p_branch and state = 'free' and capacity >= p_party_size
                  order by capacity loop
    perform private.offer_table(v_table);
    exit when exists (select 1 from public.waitlist_entries where id = v_id and status = 'offered');
  end loop;
  return v_id;
end $$;

create function public.leave_waitlist(p_entry uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.waitlist_entries;
begin
  select * into e from public.waitlist_entries where id = p_entry for update;
  if not found or not (e.user_id = auth.uid() or private.is_staff(e.branch_id)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if e.status not in ('waiting','offered') then return; end if;
  update public.waitlist_entries set status = 'cancelled', offered_table_id = null where id = p_entry;
  if e.offered_table_id is not null then perform private.offer_table(e.offered_table_id); end if;
end $$;

-- Live position for the guest's phone. Other people's names are never exposed.
create function public.waitlist_status(p_entry uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', e.status, 'party_size', e.party_size, 'name', e.name,
    'position', (select count(*) + 1 from public.waitlist_entries o
                  where o.branch_id = e.branch_id and o.status in ('waiting','offered')
                    and o.created_at < e.created_at),
    'waiting_total', (select count(*) from public.waitlist_entries o
                       where o.branch_id = e.branch_id and o.status in ('waiting','offered')),
    'table_label', t.label,
    'table_token', case when e.status = 'seated' then private.sign_table(t.id, t.qr_version) end)
    from public.waitlist_entries e
    left join public.tables t on t.id = e.offered_table_id
   where e.id = p_entry and (e.user_id = auth.uid() or private.is_staff(e.branch_id))
$$;

-- Staff confirm (seat the group) or pass (group did not show) on an offer.
create function public.staff_resolve_offer(p_entry uuid, p_seat boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.waitlist_entries;
begin
  select * into e from public.waitlist_entries where id = p_entry for update;
  if not found then raise exception 'entry_not_found' using errcode = 'P0001'; end if;
  perform private.require_staff(e.branch_id);
  if e.status <> 'offered' then
    raise exception 'not_offered' using errcode = 'P0001';
  end if;
  if p_seat then
    perform private.open_session(e.offered_table_id, e.party_size, e.user_id, e.name);
    update public.waitlist_entries set status = 'seated' where id = p_entry;
  else
    update public.waitlist_entries set status = 'no_show', offered_table_id = null where id = p_entry;
    perform private.offer_table(e.offered_table_id);
  end if;
end $$;

-- ============================================================= reservations
create function public.create_reservation(p_branch uuid, p_name text, p_phone text, p_party_size int, p_slot timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_table uuid;
  v_id uuid;
  v_staff boolean := private.is_staff(p_branch);
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  select timezone into v_tz from public.branches where id = p_branch;
  if p_slot <= now() or (p_slot at time zone v_tz)::date <> (now() at time zone v_tz)::date then
    raise exception 'slot_must_be_later_today' using errcode = 'P0001';
  end if;
  if not v_staff and exists (select 1 from public.reservations
               where user_id = auth.uid() and branch_id = p_branch and status = 'booked') then
    raise exception 'already_reserved' using errcode = 'P0001';
  end if;
  -- smallest table that fits and has no booking within 90 minutes either side
  select t.id into v_table from public.tables t
   where t.branch_id = p_branch and t.capacity >= p_party_size
     and not exists (select 1 from public.reservations r
                      where r.table_id = t.id and r.status = 'booked'
                        and r.slot_start > p_slot - interval '90 minutes'
                        and r.slot_start < p_slot + interval '90 minutes')
   order by t.capacity, t.label limit 1;
  if v_table is null then
    raise exception 'no_table_available' using errcode = 'P0001';
  end if;
  insert into public.reservations (branch_id, user_id, name, phone, party_size, slot_start, table_id)
  values (p_branch, case when v_staff then null else auth.uid() end,
          left(coalesce(nullif(trim(p_name), ''), 'Guest'), 40), nullif(trim(p_phone), ''),
          p_party_size, p_slot, v_table)
  returning id into v_id;
  return v_id;
end $$;

create function public.cancel_reservation(p_reservation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.reservations;
begin
  select * into r from public.reservations where id = p_reservation for update;
  if not found or not (r.user_id = auth.uid() or private.is_staff(r.branch_id)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  update public.reservations set status = 'cancelled' where id = p_reservation and status = 'booked';
end $$;

-- Staff seat a reservation at its table (p_seat) or mark it a no-show.
create function public.staff_resolve_reservation(p_reservation uuid, p_seat boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.reservations;
begin
  select * into r from public.reservations where id = p_reservation for update;
  if not found then raise exception 'reservation_not_found' using errcode = 'P0001'; end if;
  perform private.require_staff(r.branch_id);
  if r.status <> 'booked' then
    raise exception 'not_booked' using errcode = 'P0001';
  end if;
  if p_seat then
    perform private.open_session(r.table_id, r.party_size, r.user_id, r.name);
    update public.reservations set status = 'seated' where id = p_reservation;
  else
    update public.reservations set status = 'no_show' where id = p_reservation;
  end if;
end $$;

create function public.reservation_token(p_reservation uuid) returns text
language sql stable security definer set search_path = '' as $$
  select private.sign_table(t.id, t.qr_version)
    from public.reservations r join public.tables t on t.id = r.table_id
   where r.id = p_reservation and r.user_id = auth.uid() and r.status = 'seated'
$$;

-- =================================================================== grants
revoke execute on all functions in schema private from public, anon;
grant execute on function
  private.staff_role(uuid), private.is_staff(uuid), private.is_manager(uuid),
  private.has_guest_row(uuid), private.is_member(uuid), private.my_guest_id(uuid),
  private.can_order(uuid)
to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
