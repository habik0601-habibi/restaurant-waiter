-- 01_restaurant.sql — run once on an empty database, after the migrations.
-- One sample restaurant: Zaiqa Karahi House, Gulberg branch.
-- 12 tables, 4 kitchen stations, 36 dishes with PKR prices.

insert into public.restaurants (id, name)
values ('00000000-0000-0000-0000-0000000000a1', 'Zaiqa Karahi House');

insert into public.branches (id, restaurant_id, name, tax_rate)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
        'Gulberg, Lahore', 0.05);

insert into private.qr_keys (branch_id) values ('00000000-0000-0000-0000-0000000000b1');

insert into public.stations (branch_id, name, capacity, sort)
select '00000000-0000-0000-0000-0000000000b1', v.name, v.capacity, v.sort
from (values ('Grill & Tandoor', 4, 1), ('Stove', 3, 2), ('Fryer', 2, 3), ('Cold & Drinks', 3, 4))
  as v(name, capacity, sort);

insert into public.menu_categories (branch_id, name, sort)
select '00000000-0000-0000-0000-0000000000b1', v.name, v.sort
from (values ('Starters', 1), ('BBQ & Grill', 2), ('Karahi & Curries', 3), ('Rice', 4),
             ('Breads', 5), ('Drinks', 6), ('Desserts', 7)) as v(name, sort);

insert into public.menu_items
  (branch_id, category_id, station_id, name, description, price, cost, prep_minutes, allergens, spice_level, sort)
select '00000000-0000-0000-0000-0000000000b1', c.id, s.id, v.name, v.description,
       v.price, v.cost, v.prep, v.allergens::text[], v.spice, v.sort
from (values
  ('Starters','Fryer','Chicken Samosa','Two crisp pastries filled with spiced chicken mince.',250,90,6,'{gluten}',1,1),
  ('Starters','Fryer','Vegetable Pakora','Onion, potato and spinach fritters in gram-flour batter.',300,80,7,'{}',1,2),
  ('Starters','Cold & Drinks','Dahi Bhalla','Lentil dumplings in sweet yoghurt with tamarind chutney.',350,110,3,'{dairy}',1,3),
  ('Starters','Fryer','Fish Fingers','Crumbed river fish strips with garlic mayo.',650,280,9,'{fish,gluten,egg}',1,4),
  ('Starters','Stove','Chicken Corn Soup','Classic thick soup with shredded chicken and egg drop.',400,130,6,'{egg}',0,5),

  ('BBQ & Grill','Grill & Tandoor','Chicken Tikka','Quarter chicken marinated in yoghurt and red chilli, charcoal grilled.',550,260,18,'{dairy}',2,1),
  ('BBQ & Grill','Grill & Tandoor','Seekh Kebab','Four skewers of minced beef with coriander and green chilli.',750,350,14,'{}',2,2),
  ('BBQ & Grill','Grill & Tandoor','Malai Boti','Boneless chicken in cream, cashew and white pepper.',950,430,16,'{dairy,nuts}',1,3),
  ('BBQ & Grill','Grill & Tandoor','Reshmi Kebab','Silky chicken mince kebabs finished with butter.',850,380,14,'{dairy,egg}',1,4),
  ('BBQ & Grill','Grill & Tandoor','Beef Bihari Kebab','Thin beef strips in mustard oil and papaya marinade.',1100,560,20,'{mustard}',3,5),
  ('BBQ & Grill','Grill & Tandoor','Lamb Chops','Four chops with ginger, garlic and black pepper.',2400,1500,22,'{dairy}',2,6),
  ('BBQ & Grill','Grill & Tandoor','Grilled Fish Tikka','Boneless fish in carom seed and lemon marinade.',1600,900,18,'{fish,dairy}',2,7),

  ('Karahi & Curries','Stove','Chicken Karahi','Cooked to order in a wok with tomato, ginger and green chilli.',1450,620,22,'{}',3,1),
  ('Karahi & Curries','Stove','Mutton Karahi','Slow-finished mutton in black pepper and tomato.',2600,1500,30,'{}',3,2),
  ('Karahi & Curries','Stove','Chicken Handi','Boneless chicken in a creamy clay-pot gravy.',1650,700,20,'{dairy,nuts}',2,3),
  ('Karahi & Curries','Stove','Daal Makhni','Black lentils simmered overnight with butter and cream.',600,180,10,'{dairy}',1,4),
  ('Karahi & Curries','Stove','Palak Paneer','Cottage cheese in a spiced spinach puree.',750,300,12,'{dairy}',1,5),
  ('Karahi & Curries','Stove','Beef Nihari','Overnight beef shank stew with ginger and lemon.',1200,600,8,'{gluten}',3,6),
  ('Karahi & Curries','Stove','Haleem','Wheat, lentils and beef pounded to a thick stew.',700,260,6,'{gluten}',2,7),

  ('Rice','Stove','Chicken Biryani','Layered basmati rice and chicken with raita.',650,270,8,'{dairy}',2,1),
  ('Rice','Stove','Mutton Pulao','Fragrant yakhni rice with tender mutton.',1100,620,9,'{}',1,2),
  ('Rice','Stove','Plain Rice','Steamed basmati.',300,70,5,'{}',0,3),

  ('Breads','Grill & Tandoor','Roti','Wholewheat flatbread from the tandoor.',40,10,3,'{gluten}',0,1),
  ('Breads','Grill & Tandoor','Plain Naan','Soft leavened tandoor bread.',80,20,4,'{gluten,dairy}',0,2),
  ('Breads','Grill & Tandoor','Roghni Naan','Naan glazed with egg and sesame.',120,35,5,'{gluten,dairy,egg,sesame}',0,3),
  ('Breads','Grill & Tandoor','Garlic Naan','Naan with garlic butter and coriander.',150,40,5,'{gluten,dairy}',0,4),
  ('Breads','Grill & Tandoor','Cheese Naan','Naan stuffed with mozzarella.',350,140,6,'{gluten,dairy}',0,5),

  ('Drinks','Cold & Drinks','Mint Margarita','Fresh mint, lemon and soda over crushed ice.',350,90,3,'{}',0,1),
  ('Drinks','Cold & Drinks','Sweet Lassi','Churned yoghurt drink, served cold.',300,100,3,'{dairy}',0,2),
  ('Drinks','Cold & Drinks','Fresh Lime','Lime with soda or water, sweet or salted.',250,50,2,'{}',0,3),
  ('Drinks','Cold & Drinks','Soft Drink','Chilled 345 ml can.',150,70,1,'{}',0,4),
  ('Drinks','Cold & Drinks','Mineral Water','Small bottle.',120,50,1,'{}',0,5),
  ('Drinks','Cold & Drinks','Doodh Patti Chai','Strong tea boiled in milk.',180,50,5,'{dairy}',0,6),

  ('Desserts','Cold & Drinks','Gulab Jamun','Two warm milk dumplings in rose syrup.',300,90,2,'{dairy,gluten}',0,1),
  ('Desserts','Cold & Drinks','Kheer','Chilled rice pudding with pistachio.',350,110,2,'{dairy,nuts}',0,2),
  ('Desserts','Cold & Drinks','Gajar Halwa','Warm carrot pudding with khoya and almonds.',450,170,4,'{dairy,nuts}',0,3)
) as v(cat, station, name, description, price, cost, prep, allergens, spice, sort)
join public.menu_categories c on c.name = v.cat and c.branch_id = '00000000-0000-0000-0000-0000000000b1'
join public.stations s on s.name = v.station and s.branch_id = '00000000-0000-0000-0000-0000000000b1';

-- Sizes replace the base price, cost and prep time.
insert into public.menu_item_sizes (menu_item_id, name, price, cost, prep_minutes, sort)
select m.id, v.size, v.price, v.cost, v.prep, v.sort
from (values
  ('Chicken Karahi','Half (serves 2)',1450,620,22,1),
  ('Chicken Karahi','Full (serves 4)',2600,1150,28,2),
  ('Mutton Karahi','Half (serves 2)',2600,1500,30,1),
  ('Mutton Karahi','Full (serves 4)',4900,2900,38,2),
  ('Chicken Biryani','Single',650,270,8,1),
  ('Chicken Biryani','Family (serves 3)',1700,720,10,2),
  ('Sweet Lassi','Regular',300,100,3,1),
  ('Sweet Lassi','Large',420,140,3,2),
  ('Seekh Kebab','4 pieces',750,350,14,1),
  ('Seekh Kebab','8 pieces',1400,680,16,2)
) as v(item, size, price, cost, prep, sort)
join public.menu_items m on m.name = v.item and m.branch_id = '00000000-0000-0000-0000-0000000000b1';

insert into public.deals (branch_id, menu_item_id, title, percent_off, start_hour, end_hour)
select m.branch_id, m.id, v.title, v.pct, v.h1, v.h2
from (values ('Sweet Lassi','Afternoon cooler',20,15,18), ('Chicken Samosa','Tea-time snack',15,15,18))
  as v(item, title, pct, h1, h2)
join public.menu_items m on m.name = v.item and m.branch_id = '00000000-0000-0000-0000-0000000000b1';

-- Floor: positions are percentages of the map's width and height.
insert into public.tables (branch_id, label, capacity, pos_x, pos_y, shape)
select '00000000-0000-0000-0000-0000000000b1', v.label, v.capacity, v.x, v.y, v.shape
from (values
  ('T1',2,10,14,'round'), ('T2',2,28,14,'round'), ('T3',2,46,14,'round'), ('T4',2,64,14,'round'),
  ('T5',4,12,44,'square'), ('T6',4,32,44,'square'), ('T7',4,52,44,'square'), ('T8',4,72,44,'square'),
  ('T9',4,88,18,'square'),
  ('T10',6,18,78,'long'), ('T11',6,48,78,'long'), ('T12',8,80,78,'long')
) as v(label, capacity, x, y, shape);
