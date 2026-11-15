-- 0005_close_table_without_session.sql
-- Recovery path: if a table is occupied but has no live session (for example
-- the session row was removed by hand, or it expired and was cleaned up),
-- staff could not close it. staff_close_table now moves such a table on
-- through the state machine instead of refusing.

create or replace function public.staff_close_table(p_table uuid) returns void
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
    if t.state = 'seated' then
      perform private.transition_table(p_table, 'free');
      perform private.offer_table(p_table);
    elsif t.state in ('ordered','eating','bill_requested') then
      perform private.transition_table(p_table, 'paid_dirty');
    else
      raise exception 'no_live_session' using errcode = 'P0001';
    end if;
    return;
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

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
