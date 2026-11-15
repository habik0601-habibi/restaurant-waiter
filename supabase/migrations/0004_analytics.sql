-- 0004_analytics.sql — read-only aggregates for the owner dashboard.
-- Only an owner or manager of the branch may call them. Each result says how
-- much of it comes from generated sample rows, so the UI can label it.

create function public.owner_menu_stats(p_branch uuid, p_days int default 28)
returns table (
  menu_item_id uuid, name text, category text, price int, cost int,
  units bigint, revenue bigint, profit bigint, sample_units bigint
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_manager(p_branch) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  return query
    select m.id, m.name, c.name, m.price, m.cost,
           coalesce(sum(i.qty), 0)::bigint,
           coalesce(sum(i.qty * i.unit_price), 0)::bigint,
           coalesce(sum(i.qty * (i.unit_price - i.unit_cost)), 0)::bigint,
           coalesce(sum(i.qty) filter (where i.is_sample), 0)::bigint
      from public.menu_items m
      join public.menu_categories c on c.id = m.category_id
      left join public.order_items i
        on i.menu_item_id = m.id and i.status <> 'cancelled'
       and i.created_at > now() - make_interval(days => p_days)
     where m.branch_id = p_branch
     group by m.id, m.name, c.name, m.price, m.cost
     order by 6 desc;
end $$;

create function public.owner_hourly(p_branch uuid, p_days int default 28)
returns table (hour int, orders bigint, revenue bigint, sample_orders bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
begin
  if not private.is_manager(p_branch) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select timezone into v_tz from public.branches where id = p_branch;
  return query
    select extract(hour from o.placed_at at time zone v_tz)::int,
           count(distinct o.id)::bigint,
           coalesce(sum(i.qty * i.unit_price), 0)::bigint,
           count(distinct o.id) filter (where o.is_sample)::bigint
      from public.orders o
      join public.order_items i on i.order_id = o.id and i.status <> 'cancelled'
     where o.branch_id = p_branch and o.status <> 'cancelled'
       and o.placed_at > now() - make_interval(days => p_days)
     group by 1 order by 1;
end $$;

create function public.owner_summary(p_branch uuid, p_days int default 28) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v jsonb;
begin
  if not private.is_manager(p_branch) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select timezone into v_tz from public.branches where id = p_branch;
  select jsonb_build_object(
    'orders', count(distinct o.id),
    'sample_orders', count(distinct o.id) filter (where o.is_sample),
    'revenue', coalesce(sum(i.qty * i.unit_price), 0),
    'profit', coalesce(sum(i.qty * (i.unit_price - i.unit_cost)), 0),
    'today_orders', count(distinct o.id) filter (
        where (o.placed_at at time zone v_tz)::date = (now() at time zone v_tz)::date),
    'today_revenue', coalesce(sum(i.qty * i.unit_price) filter (
        where (o.placed_at at time zone v_tz)::date = (now() at time zone v_tz)::date), 0))
    into v
    from public.orders o
    join public.order_items i on i.order_id = o.id and i.status <> 'cancelled'
   where o.branch_id = p_branch and o.status <> 'cancelled'
     and o.placed_at > now() - make_interval(days => p_days);
  return v || jsonb_build_object(
    'days', p_days,
    'rating_avg', (select round(avg(stars), 2) from public.ratings where branch_id = p_branch),
    'rating_count', (select count(*) from public.ratings where branch_id = p_branch),
    'live_orders', (select count(*) from public.orders where branch_id = p_branch and status = 'open' and not is_sample),
    'tables_active', (select count(*) from public.tables where branch_id = p_branch and state <> 'free'),
    'tables_total', (select count(*) from public.tables where branch_id = p_branch));
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
