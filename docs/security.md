# Security model for table sessions

Goal: someone who photographed a table's QR code last week cannot place a prank order from home. More generally, nothing a guest can do in a browser console should get past the rules.

SQL: [`0002_state_machine_and_rls.sql`](../supabase/migrations/0002_state_machine_and_rls.sql), [`0003_functions.sql`](../supabase/migrations/0003_functions.sql).
Tests: [`tests/db.security.test.ts`](../tests/db.security.test.ts) (33 tests, run with `npm run test:db`).

## The idea in one paragraph

The QR code only says **which table**. It grants nothing. Permission to order comes from an **open table session** that a member of staff opened after looking at the table, and from the phone being an **approved guest** of that session. Both facts live in the database, and every write path checks them there. When the bill is paid the session closes, and the same phones that were ordering a minute ago are refused.

## The pieces

### 1. Every phone has an identity

Guests do not log in, but the app signs each phone in anonymously with Supabase Auth. The phone gets its own user id and a signed JWT, so the database can tell phones apart and row-level security has something to check. Staff use email and password.

The `anon` role (no sign-in at all) has no access to any table or function.

### 2. The QR token is signed

```
token = <table id> . <qr_version> . HMAC-SHA256(table id + version, branch secret)[first 32 hex chars]
```

- The secret is in `private.qr_keys`. The `private` schema is not exposed through the API.
- A forged or altered token is rejected (`invalid_token`). A signature from one table cannot be reused for another.
- Bumping `qr_version` invalidates every printed copy of that table's code.

The signature stops people guessing or enumerating table URLs. It does not stop a photo of a real code, which is why the token grants nothing by itself.

### 3. Scanning files a request

`request_session(token, name, party_size)` creates a **pending** session and a **pending** guest row. Nothing else happens. The floor map shows "Table 5 wants to order" and staff accept or deny after looking at the table. A photo taken at home produces a request for a table with nobody at it, and staff deny it. Three denials in an hour and the phone is throttled.

A second phone that scans an already open table is also pending until staff, or someone already seated there, lets it in.

### 4. One rule guards ordering

```sql
private.can_order(session) :=
      the session is 'open'
  and it has not expired            (4 hours by default)
  and the table is seated, ordered or eating   (not after the bill)
  and the caller is an approved guest of it
```

It is checked in two places:

- **Row-level security on `cart_items`** (insert, update, delete), together with "the line belongs to you".
- **`place_order()`**, the only code that can create an order.

`orders` and `order_items` have no insert, update or delete policy and no write grant, so a direct write from the browser is refused whatever it contains. Prices are computed inside `place_order()` from the menu; the browser never sends a price.

### 5. Payment closes the session

When the last share of the bill is paid, `pay_share()` sets the session to `closed` and moves the table to "paid, needs cleaning". From that moment `can_order()` is false for everyone. Scanning again just files a new pending request.

### 6. Table state changes in one place

`private.transition_table()` is the only code that writes `tables.state`. It checks the move against the `table_transitions` table and logs it. A trigger rejects any other update to that column, including one from the owner. The TypeScript module that drives the buttons has the same list, and a test asserts they are identical.

## Who can do what

| Action | Guest, not approved | Approved guest, open session | After the session closes | Staff |
|---|---|---|---|---|
| Read the menu | yes | yes | yes | yes |
| See the table's cart and orders | no | yes | read only | yes |
| Add to cart | no | own lines only | no | no |
| Place an order | no | yes | no | no |
| Approve a request | no | joiners to own table | no | yes |
| Change kitchen status | no | no | no | yes |
| Change table state | no | only through ordering and paying | no | through staff functions |
| Edit the menu | no | no | no | owner and manager |

## What the tests prove

Each test acts as a browser would, with only the public key.

1. A forged token, and a signature moved to another table, are rejected. A client that is not signed in gets nothing.
2. A scan alone cannot add to the cart or place an order, and a guest cannot approve themself.
3. A stranger holding the token cannot read the cart, add to it, order or call a waiter.
4. A guest cannot change another guest's cart lines or add lines in their name.
5. Orders and order items cannot be inserted or edited directly; only `place_order()` works.
6. Illegal table transitions are refused; even the owner cannot write the state column.
7. Bill shares add up exactly to the total.
8. After payment the same approved phones are refused, and a re-scan is only a pending request.

**Status:** all 33 tests pass against the live Supabase project (`npm run test:db`). The same flow was also walked by hand in the browser: scan, staff approval, shared cart, order, kitchen, bill, simulated payment, receipt.

## Limits and honest caveats

- **Staff approval is the human step.** If a waiter accepts a request without looking at the table, the prank succeeds. The UI says "look at the table before you accept", but it cannot enforce it.
- **A guest at the table can let anyone in.** That is deliberate (friends join without bothering staff), and that guest is present and accountable.
- **Anonymous identities are cheap.** A cleared browser is a new guest, so the per-phone throttle slows abuse but does not stop a determined person. Supabase's own rate limit on anonymous sign-ins applies, and CAPTCHA can be enabled there.
- **No location check.** GPS can be faked, so it is not used.
- **The re-plan function can be called by any signed-in user.** It takes only a branch id and computes from database state, so the worst case is wasted compute.
- **Payments are simulated.** No card data is handled.
- **Supabase's linter warns** that the functions are `SECURITY DEFINER` and callable by signed-in users. That is the design: each one checks the caller itself.
