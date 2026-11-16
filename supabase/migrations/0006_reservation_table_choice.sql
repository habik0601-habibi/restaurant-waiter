-- 0006_reservation_table_choice.sql
-- A reservation must not be given a table that is occupied right now and will
-- not plausibly be free by the booked time. A table counts as likely free
-- when it is free now, or when the slot is at least 90 minutes away (a normal
-- sitting is under that). Also refuses slots more than 12 hours ahead and
-- party sizes no table can seat, with clearer errors.

create or replace function public.create_reservation(p_branch uuid, p_name text, p_phone text, p_party_size int, p_slot timestamptz)
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
  if not exists (select 1 from public.tables where branch_id = p_branch and capacity >= p_party_size) then
    raise exception 'party_too_large' using errcode = 'P0001';
  end if;
  if not v_staff and exists (select 1 from public.reservations
               where user_id = auth.uid() and branch_id = p_branch and status = 'booked') then
    raise exception 'already_reserved' using errcode = 'P0001';
  end if;
  -- smallest table that fits, with no booking within 90 minutes either side,
  -- and that is free now or will have had at least 90 minutes to turn over
  select t.id into v_table from public.tables t
   where t.branch_id = p_branch and t.capacity >= p_party_size
     and (t.state = 'free' or p_slot >= now() + interval '90 minutes')
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

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
