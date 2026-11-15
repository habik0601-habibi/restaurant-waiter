-- 02_staff_users.sql — demo staff logins.
-- Replace the three :PASSWORD placeholders before running (the real values
-- live only in .env.local, which is not committed). Run once.
-- Emails use the reserved .test domain, so no mail is ever sent.

with new_users as (
  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
     raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
     confirmation_token, email_change, email_change_token_new, recovery_token)
  select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
         v.email, extensions.crypt(v.password, extensions.gen_salt('bf')), now(),
         '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', ''
  from (values
    ('owner@zaiqa.test',   ':OWNER_PASSWORD'),
    ('waiter@zaiqa.test',  ':WAITER_PASSWORD'),
    ('kitchen@zaiqa.test', ':KITCHEN_PASSWORD')
  ) as v(email, password)
  returning id, email
), ident as (
  insert into auth.identities
    (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  select gen_random_uuid(), u.id, u.id::text,
         jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
         'email', now(), now(), now()
  from new_users u
)
insert into public.staff_members (user_id, branch_id, role, display_name)
select u.id, '00000000-0000-0000-0000-0000000000b1',
       split_part(u.email, '@', 1),
       initcap(split_part(u.email, '@', 1))
from new_users u;
