# Hardware & Construction Supply POS — starter kit

Offline-first POS for a hardware store, built around two apps and one
database:

- **POS terminal** — local-only. Cashiers write to a local database
  instantly; a background worker pushes completed sales up when a
  connection is available. It never needs to be online to ring up a sale.
- **Admin app** — also local-first (its own IndexedDB, its own outbox), so
  Inventory can be viewed and edited whether or not the store currently has
  internet, and changes sync up automatically once it's back. It isn't a
  thin dashboard that goes blank offline.

Both talk to the same Supabase Postgres database, hosted as static builds
on **Cloudflare Pages**. Full architecture diagram was shown earlier in
chat — this file is the setup guide and the reasoning behind the pieces.

Design note: the UI is deliberately plain and uncluttered — big touch
targets, everyday words instead of technical labels — because the person
using the till day to day isn't a technical user. It also follows how a
real retail terminal scopes manager approval: free to edit a draft order
(add, remove, change quantity — nothing's committed yet), PIN required only
to void a sale that's *already been paid*, or for "No Sale" (opening the
drawer with nothing rung up). Those are the two actual loss-prevention
checkpoints; ordinary order editing isn't one of them.

## What's in the kit

| File | What it is |
|---|---|
| `schema.sql` | Cloud schema (Postgres) — the six tables you asked for, plus a `stock_movements` ledger and two immutability triggers |
| `local-db.js` | The local schema (IndexedDB via Dexie.js), field-for-field mirror of the cloud tables. Shared shape for both apps — the POS terminal just never calls the product-writing functions |
| `input-handler.js` | Quick-select, search, scanner detection, and manager PIN — with a comment marking exactly which actions should call the PIN check and which shouldn't |
| `sync-worker.js` | Local write + outbox helpers (sales, voids, shifts, products/stock), real connectivity checks, backoff push, catalog pull |
| `app.html` | **The demo.** Staff login (tap your name, enter PIN), then role-based navigation: **Cashier** sees POS Billing + Inventory; **Manager/Owner** additionally see User Management. One shared product catalog — a stock adjustment made in Inventory shows up on the Billing screen immediately, the way it needs to in the real thing. |

`app.html` is a self-contained mock-data demo of the UI/UX — open it
directly in a browser, no install, no server. Try logging in as different
staff (see the PIN list below) to see the navigation change. Swap the
in-memory `USERS`/`PRODUCTS` arrays and the save functions for real calls
into `local-db.js` / `sync-worker.js` to make it live.

**Demo logins** (PIN pad, tap a name first):
| Name | Role | PIN |
|---|---|---|
| Ana Reyes | Cashier | 1111 |
| Mark Santos | Cashier | 2222 |
| Liza Cruz | Manager | 1234 |
| Roberto Dela Cruz | Owner | 9999 |

A note on the login itself: a 4-digit PIN is the right amount of friction
for staff standing at a physical terminal in the store — fast, and
physical access is already a control. It is *not* enough on its own if you
expose the admin app outside the store (a phone or PC at home, per your
original brief) — nothing stops repeated guesses without a physical
barrier. If you add remote admin access, put that specific path behind
real authentication (Supabase Auth email+password at minimum) and keep the
in-store PIN for what it's good at: fast staff switching at the till.

Both HTML files are self-contained mock-data demos of the UI/UX — open
either directly in a browser, no install, no server. Swap the in-memory
arrays for real calls into `local-db.js` / `sync-worker.js` to make them
live.

## Two defaults, stated plainly

Your brief left two stack choices open. Here's what this kit assumes and why:

- **Browser + IndexedDB (Dexie.js)**, not SQLite/SQLCipher. No install, runs
  on any device already in the store, and both your barcode scanners
  (HID keyboard-wedge) and receipt printing work from inside a browser tab —
  see the printing section below for the one place that's not quite true.
- **Supabase (Postgres)**, not Turso. Mainly because of one operational
  detail that matters for a store open 8am–7pm daily — see the free-tier
  section below. Turso is a genuinely reasonable alternative; the schema
  would need adapting to SQLite dialect (mostly swapping `UUID`/`TIMESTAMPTZ`/
  `JSONB` types and moving the two triggers into application code, since
  libSQL's trigger support is thinner than Postgres's).

## Setup

1. **Create a free Supabase project** at supabase.com. In the SQL editor,
   run `schema.sql` top to bottom.
2. **Get your project URL and anon key** (Settings → API). These are safe
   to ship to the browser — that's what "anon" means — but see the security
   note below, because it means Row Level Security is doing real work here,
   not just a nice-to-have.
3. Install dependencies in your frontend project:
   ```
   npm install dexie bcryptjs @supabase/supabase-js
   ```
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment
   variables (adjust the prefix if you're not on Vite).
5. Wire `local-db.js`, `input-handler.js`, and `sync-worker.js` into your UI.
   `app.html` shows one concrete example of the login + navigation + input
   handling working together; the sync half needs a real Supabase project
   to demonstrate, so it's not runnable standalone the way the demo is.
6. **POS app:** call `startSyncWorker()` once on load, then `openShift()`
   at clock-in, `completeSale()` at checkout, `voidSaleItem()` on a PIN-
   approved void, `closeShift()` at clock-out.
7. **Admin app:** call `startSyncWorker()` on load too, then `saveProduct()`
   for add/edit, `adjustStock()` for stock changes — both work identically
   online or offline, they just queue either way.
8. Deploy both as static builds on Cloudflare Pages — see why below.

## Free-tier reality check (checked August 2026)

You asked for zero recurring cost, so these are worth reading before you
commit, not after:

- **Vercel Hobby will not work for this.** Its terms restrict the free tier
  to non-commercial, personal use — a revenue-generating store is
  explicitly out of scope, regardless of traffic volume. **Cloudflare
  Pages** is the better fit here: commercial use is allowed on the free
  tier, static asset requests are unlimited, and since this architecture
  talks directly to Supabase from the browser, you don't need a serverless
  function layer at all — just static hosting for the built frontend.
- **Supabase's free tier auto-pauses a project after 7 days with zero
  database activity.** Commercial use is explicitly permitted and there's
  no credit card requirement — the pause is the operational catch, not a
  legal one. For a store that opens daily, this is a non-issue in practice
  (any day of sales resets the clock); the actual risk window is an
  extended closure — a week-plus holiday shutdown, for instance. Cheapest
  mitigation: anything that pings the database periodically (a scheduled
  health check, or just opening the admin dashboard once) keeps it awake.
- **This is the specific reason Neon isn't the default here.** Neon's free
  tier caps at 100 compute-hours a month and scales to zero after 5 minutes
  idle — great for bursty side projects, but `sync-worker.js` polls every
  15 seconds while online, which means compute effectively never scales
  down during an 11-hour operating day. That alone would burn through the
  monthly cap well before the month is out, well before you'd hit Neon's
  500MB storage limit. Supabase's model (unlimited requests, pause only on
  true multi-day silence) fits a "continuously open" pattern much better.
- **Turso is worth a second look if the Supabase pause bothers you.** 5GB
  storage, 500M row reads and 10M row writes a month, commercial use
  allowed, and no inactivity-pause behavior at all in the way Postgres
  options have it. The trade-off is you lose Supabase's built-in REST API,
  Realtime, and the trigger-based immutability enforcement in `schema.sql`
  — you'd own more of that in application code instead.

Prices and limits on all of these shift often enough that it's worth
re-checking the vendor's own pricing page before you build on any specific
number here.

## Printing and the cash drawer

Worth knowing before you're debugging it live: a browser cannot send raw
ESC/POS bytes to a USB thermal printer on its own — there's no web API for
that. Three real options, roughly in order of effort:

1. **Browser print dialog + CSS sized to receipt width.** Works if your
   printer has a normal driver installed. Simplest, but you don't get raw
   ESC/POS control (barcodes, cut commands) — you get whatever the driver
   does with a styled HTML page.
2. **QZ Tray** (free, open source, actively maintained) — a small local
   bridge app that runs once per till and lets the browser talk to it over
   a websocket, from which you can send real ESC/POS. This is the
   standard way point-of-sale web apps do silent, driver-independent
   thermal printing.
3. **WebUSB/WebSerial** — no bridge app, but Chrome/Edge-only and requires
   the printer to expose a compatible interface.

The drawer-kick is not a separate problem: cash drawers connect via RJ11 to
the printer itself, and "open the drawer" is just another ESC/POS command
sent through whichever of the above channels you're already using for
receipts. Trigger it as the last step inside `completeSale()`, after the
local write succeeds — never before, so a crashed print job can't open the
drawer on a sale that didn't actually go through.

## Security note: RLS is not optional here

This kit's lean setup (browser talks directly to Supabase, no custom API
layer) means the anon key ships to every terminal. Supabase enables Row
Level Security by default on new tables — with policies, every table is
simply unreachable, which is the safe failure mode, but you do need to add
them. `schema.sql` has commented-out starting policies. Because you have
your own PIN-based `users` table rather than using Supabase Auth, those
policies can't distinguish "which cashier" — they just answer "is this
request holding the anon key at all." Real per-person authorization stays
where it already is: your PIN checks in `input-handler.js`. That's a
reasonable trade-off for a small store's threat model (nobody can just
`curl` your prices or PINs, but a leaked key could insert fake sales rows)
— not bank-grade, but proportionate, and worth revisiting if you ever add
a second location or handle higher-value transactions.

## Not built yet, on purpose

Your task list was schema + input handling + sync logic — these stayed
scoped to that, plus what those three genuinely needed to work correctly
(the stock ledger, connectivity handling, PIN lockout). Natural next
pieces, all straightforward from here:

- An actual ESC/POS receipt template
- The admin dashboard queries (shift breakdown, top sellers) and a UI for them
- The checkout/cart screen that visually wires `input-handler.js` and
  `sync-worker.js` together (`demo.html` only wires the input half, with
  mock data)
