# Architecture overview

## What it is

One web app, three surfaces, one Postgres database.

| Surface | Who | Login | Routes |
|---|---|---|---|
| Guest app | Guests at a table, on their phone | none (anonymous identity) | `/t/<token>`, `/join` |
| Staff app | Waiters and kitchen, tablet or phone | email and password | `/staff`, `/staff/kitchen`, `/staff/waitlist`, `/staff/qr` |
| Owner dashboard | Owner or manager, desktop | email and password | `/owner`, `/owner/menu` |

## Stack and why

- **Vite + React + TypeScript + Tailwind**, built as a static single-page app and deployed to Vercel.
- **Supabase**: Postgres, Auth, row-level security, Realtime, one Edge Function.

Vite was chosen over Next.js because every live screen is a browser talking to Supabase over a websocket, so server rendering adds nothing, and because the security rules live in the database, not in a web server. There is no backend code of our own apart from SQL and one edge function.

```
 phone (guest)        tablet (staff)        laptop (owner)
      \                     |                     /
       \---- supabase-js: REST, RPC, Realtime ---/
                           |
        +------------------+-------------------+
        |               Supabase               |
        |  Auth (anonymous guests, staff)      |
        |  Postgres                            |
        |    tables + row-level security       |
        |    functions (all important writes)  |
        |    table state machine               |
        |  Realtime (row changes -> screens)   |
        |  Edge Function "replan"              |
        |    runs the scheduler module         |
        +--------------------------------------+
```

## Where the logic lives

| Concern | Place | Why there |
|---|---|---|
| Who may order, who may see what | Postgres RLS + functions | Cannot be bypassed from a browser. See [security.md](security.md). |
| Table states | `private.transition_table()` + `table_transitions` | One place, every caller. |
| Prices, bill and split maths | Postgres functions | The browser never sends a price. |
| Kitchen plan | `src/lib/scheduler/scheduler.ts`, run by the `replan` edge function | Pure and testable; does not depend on a kitchen tablet being open. See [scheduler.md](scheduler.md). |
| Screens | React pages | Display and input only. |

## Data model

Every operational table has `branch_id`, so several branches per restaurant can be added without a rewrite.

- **Tenancy**: `restaurants`, `branches` (tax rate, time zone, settings), `staff_members` (role: owner, manager, waiter, kitchen).
- **Menu**: `stations` (capacity), `menu_categories`, `menu_items` (price, ingredient cost, prep minutes, station, allergens, spice, availability), `menu_item_sizes`, `deals`.
- **Floor**: `tables` (capacity, map position, state, state_since, qr_version), `table_transitions`, `table_state_events` (audit log with a `source` column).
- **Sessions**: `table_sessions` (pending, open, closed, denied, expired), `session_guests` (one row per phone).
- **Ordering**: `cart_items`, `orders`, `order_items` (one row per unit to cook; price, cost and prep time snapshotted; planned and actual times).
- **Service**: `waiter_calls`.
- **Billing**: `bills`, `bill_shares`, `payments` (`is_simulated`, `provider`), `ratings`.
- **Queue**: `waitlist_entries`, `reservations`.
- **Private**: `private.qr_keys`.

## The shared state machine

The floor map, sessions and waitlist are all driven by one table state.

```
free -> seated -> ordered <-> eating -> bill_requested -> paid_dirty -> free
          |          \____________/__________________________^
          v            (staff close: settled at the counter)
        free (guests left before ordering)
```

| Transition | Caused by |
|---|---|
| free to seated | Staff accept a scan, seat a walk-in, confirm a waitlist offer, or seat a reservation. Opens the session. |
| seated to ordered | First `place_order()`. |
| ordered to eating | Kitchen marks the last dish of the last open order served. |
| eating to ordered | Another order is placed. |
| eating to bill_requested | Guest taps "Pay the bill". |
| bill_requested to paid_dirty | Last bill share paid. Closes the session. |
| paid_dirty to free | Staff tap "Table cleared". The table is then offered to the first waiting group that fits. |

A table that stays in one state longer than the branch's configured limit is flagged on the floor map.

## Realtime

Every live screen uses one hook, `useLive`: fetch, subscribe to row changes on the relevant tables, refetch on any event, and poll slowly as a fallback. Refetching through the normal API means row-level security decides what each screen sees, for inserts, updates and deletes alike.

| Screen | Watches |
|---|---|
| Shared cart, orders, bill (guest) | rows of its own session |
| Kitchen display | `order_items`, `orders` of the branch |
| Floor map | `tables`, sessions, guests, calls, orders, bills |
| Waitlist | `waitlist_entries`, `reservations`, `tables` |

One exception: a guest's waitlist position depends on other people's rows, which the guest may not read. The position comes from a function and is polled every 5 seconds.

## Flow of one order

1. Guest scans, requests, staff accept: session opens, table is `seated`.
2. Guests add to the shared cart (direct writes, guarded by RLS).
3. `place_order()` turns the cart into an order, one row per unit, with server-side prices. Table is `ordered`.
4. The app calls the `replan` edge function. It loads open dishes, runs the scheduler, and writes each dish's planned start and each order's estimated ready time.
5. The kitchen display shows dishes per station in planned order. Cooks tap Start and Ready; each tap, and a 30 second timer, triggers a re-plan.
6. "Served" on the last dish moves the table to `eating`.
7. Guest requests the bill, chooses a split and tip, and each share is paid (simulated). The session closes.

## Designed for later (not built)

| Future feature | What is already in place |
|---|---|
| AI waiter in Urdu and English | Menu data is structured (allergens, spice, sizes); an assistant can add to the same cart through the same rules. |
| Stock tracking, hiding sold-out dishes | `menu_items.is_available` is live on every phone and enforced when ordering. |
| JazzCash, Easypaisa, Raast, WhatsApp receipts | `payments.provider`, `provider_ref`, `is_simulated`; methods already named. |
| Camera-based occupancy | `table_state_events.source` records who reported a change. |
| Offline mode | Not prepared beyond the fetch-on-change pattern. This would need real work. |
| Tax invoices | `bills.tax`, per-branch `tax_rate`, price snapshots on order items. |
| Multiple branches | `branch_id` everywhere; staff belong to a branch. |

## What is simulated or sample

- **Payments** are simulated and labelled so in the guest app.
- **Order history** on the owner dashboard is generated by `supabase/seed/03_sample_history.sql`, flagged `is_sample`, and labelled "Sample data" on every chart.
