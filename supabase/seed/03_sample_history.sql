-- 03_sample_history.sql — GENERATED sample data for the owner dashboard.
-- Creates four weeks of plausible past orders so the profit analysis has
-- something to show. Every row is flagged is_sample = true and the dashboard
-- labels it "Sample data". It is never presented as real trading.
--
-- Re-runnable: it first deletes earlier sample rows.
-- To remove sample data for good:  delete from public.orders where is_sample;

delete from public.orders where is_sample and branch_id = '00000000-0000-0000-0000-0000000000b1';

with hours(hour, avg_orders) as (
  -- average orders per hour: lunch peak, dead afternoon, strong late dinner
  values (12, 2.0), (13, 5.0), (14, 6.0), (15, 2.5), (16, 1.2), (17, 1.5),
         (18, 2.5), (19, 5.0), (20, 8.0), (21, 9.0), (22, 7.0), (23, 3.0)
),
days as (
  select d, ((now() at time zone 'Asia/Karachi')::date - d) as day
    from generate_series(1, 28) d
),
slots as (
  select day, hour,
         greatest(0, round(avg_orders * (0.6 + random() * 0.8)
           * case when extract(dow from day) in (5, 6, 0) then 1.35 else 1 end))::int as n
    from days cross join hours
),
new_orders as (
  insert into public.orders (branch_id, table_id, order_no, status, placed_at, served_at, is_sample)
  select '00000000-0000-0000-0000-0000000000b1',
         (select id from public.tables t where t.branch_id = '00000000-0000-0000-0000-0000000000b1'
           order by random() + s.hour * 0 limit 1),
         0, 'served', p.placed, p.placed + interval '35 minutes', true
    from slots s
    cross join lateral generate_series(1, s.n) g
    cross join lateral (
      select ((s.day + make_interval(hours => s.hour, mins => (random() * 59)::int + g * 0))
               at time zone 'Asia/Karachi') as placed
    ) p
  returning id, placed_at
),
-- how often each dish is picked (relative weight)
popularity(name, weight) as (values
  ('Plain Naan', 30), ('Roti', 22), ('Garlic Naan', 14), ('Soft Drink', 22), ('Mineral Water', 16),
  ('Chicken Biryani', 20), ('Chicken Karahi', 18), ('Mutton Karahi', 12), ('Chicken Tikka', 14),
  ('Seekh Kebab', 13), ('Daal Makhni', 9), ('Mint Margarita', 9), ('Sweet Lassi', 8),
  ('Doodh Patti Chai', 10), ('Chicken Samosa', 8), ('Beef Nihari', 7), ('Chicken Handi', 5),
  ('Malai Boti', 3), ('Reshmi Kebab', 4), ('Gulab Jamun', 6), ('Kheer', 3), ('Fresh Lime', 5),
  ('Vegetable Pakora', 4), ('Dahi Bhalla', 3), ('Haleem', 4), ('Mutton Pulao', 5),
  ('Beef Bihari Kebab', 3), ('Lamb Chops', 2), ('Grilled Fish Tikka', 1.5), ('Fish Fingers', 1.5),
  ('Palak Paneer', 2), ('Cheese Naan', 2.5), ('Roghni Naan', 4), ('Chicken Corn Soup', 2.5),
  ('Plain Rice', 3), ('Gajar Halwa', 1.5)
)
insert into public.order_items
  (order_id, branch_id, menu_item_id, station_id, name, qty, unit_price, unit_cost, prep_minutes,
   status, created_at, served_at, is_sample)
select o.id, '00000000-0000-0000-0000-0000000000b1', pick.id, pick.station_id, pick.name,
       pick.qty, pick.price, pick.cost, pick.prep_minutes,
       'served', o.placed_at, o.placed_at + interval '35 minutes', true
  from new_orders o
  cross join lateral (
    -- weighted sampling without replacement: 2 to 6 different dishes per order
    select m.id, m.station_id, m.name, m.price, m.cost, m.prep_minutes,
           case when m.price < 400 and random() < 0.5 then 2 else 1 end as qty
      from public.menu_items m
      join popularity w on w.name = m.name
     where m.branch_id = '00000000-0000-0000-0000-0000000000b1'
     order by -ln(random()) / w.weight
     limit 2 + (abs(hashtext(o.id::text)) % 5)
  ) pick;
