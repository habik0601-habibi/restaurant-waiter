# Restaurant table ordering

A web app that lets a restaurant's website do the work of a waiter. Guests scan a QR code at their table and order, call staff and pay from their phone. Staff see the whole room on one live floor map. The kitchen cooks to a schedule that makes each table's dishes finish together. The owner sees which dishes make money.

Sample restaurant: Zaiqa Karahi House (12 tables, 4 kitchen stations, 36 dishes, prices in PKR).

## What is different about it

- **Kitchen scheduling optimiser.** Cuts the gap between a table's first and last dish by 71% to 78% in simulation, at a cost of 7% to 11% more wait. See [docs/scheduler.md](docs/scheduler.md).
- **Session security.** A photographed QR code cannot place an order. Enforced in the database. See [docs/security.md](docs/security.md).
- **One state machine** drives tables, sessions and the waitlist. See [docs/architecture.md](docs/architecture.md).

## Run it locally

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill in your Supabase URL and publishable key.

```bash
npm run dev
```

Open http://localhost:5173. Staff and owner screens ask for a login; guest tables open from the QR codes at `/staff/qr`.

## Set up the database (once)

1. In Supabase, enable **Authentication → Sign In / Providers → Allow anonymous sign-ins**. Guests need it.
2. Run the files in `supabase/migrations/` in order (`0001` to `0005`).
3. Run `supabase/seed/01_restaurant.sql`.
4. Edit the three passwords in `supabase/seed/02_staff_users.sql`, run it, and put the same values in `.env.local`.
5. Optional: run `supabase/seed/03_sample_history.sql` for four weeks of generated orders (labelled as sample data in the dashboard).
6. Deploy the scheduler function: `npm run sync:scheduler` then `supabase functions deploy replan`.

## Demo script (one laptop)

1. Log in at `/staff` and open **QR codes**.
2. On a table card click **Open as guest**, then **Open as 2nd guest** (two tabs act as two phones).
3. In the first tab request to order. On the **Floor** map accept the scan.
4. In the second tab ask to join; the first guest lets them in.
5. Both add dishes; the cart updates live in both tabs. Place the order.
6. Open **Kitchen**: dishes are listed per station with planned start times. Start, ready, served.
7. Guest: pay the bill, split by who ordered, add a tip, pay (simulated).
8. Try to order again from the guest tab: refused. Clear the table on the floor map.

## Tests

| Command | What it covers | Needs |
|---|---|---|
| `npm test` | Scheduler (22 tests) and table state machine (10 tests) | nothing |
| `npm run test:db` | Session security and state rules against the real database (33 tests) | `.env.local`, anonymous sign-ins enabled |
| `npm run simulate` | FCFS vs optimised scheduler on generated evenings (about 4 minutes) | nothing |

## Deploy to Vercel

1. Import the GitHub repo in Vercel. Framework preset: **Vite**. Build command `npm run build`, output `dist`.
2. Add the three `VITE_` variables from `.env.example` as environment variables.
3. Deploy. `vercel.json` already rewrites all paths to `index.html` so deep links such as `/t/<token>` work.
4. Printed QR codes contain the site's address, so print them from the deployed site, not from localhost.

Only the publishable key goes in the browser. It is safe to expose: every rule is enforced in the database.

## Project layout

```
src/lib/scheduler/        the scheduler module and its tests
src/lib/tableStateMachine.ts
src/pages/guest|staff|owner/
supabase/migrations/      schema, state machine, RLS, functions, analytics
supabase/seed/            sample restaurant, staff logins, sample history
supabase/functions/replan the edge function that runs the scheduler
scripts/simulate.ts       scheduler simulation
tests/                    database security tests
docs/                     architecture, scheduler, security
```

## Not real

- Payments are simulated. No provider is contacted.
- Dashboard history is generated sample data until real orders exist, and is labelled as such.
