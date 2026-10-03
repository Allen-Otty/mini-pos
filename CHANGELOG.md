# Dogo POS â€” Changelog

Newest first. Each entry lists what changed and why, so nothing has to be rediscovered from the git log.


## 2026-10-03 — Paystack now collects real money; production guards for M-Pesa, simulator and demo data

**Paystack is wired to the real Paystack API.** `initiatePaystackPayment` now calls `POST /transaction/initialize` with the configured secret key and returns Paystack's hosted `authorization_url`; the POS sends the customer to that page (`payment-complete.html` is the return URL). The poll endpoint re-verifies every pending Paystack payment with `GET /transaction/verify/:ref` before marking it success — the webhook is convenience, the verify call is the source of truth. Amounts are checked against our own request (kobo conversion, small tolerance).

**M-Pesa production guard:** with `MPESA_ENVIRONMENT=production` and no live Daraja credentials, initiate now throws instead of pretending an STK prompt was sent.

**Demo data and simulator:** the fabricated demo ledger is now seeded only when `DEMO_MODE=1` is set; the `/simulate/:id` endpoint returns 404 when `NODE_ENV=production`.

**Deploy notes:** set `PAYSTACK_SECRET_KEY` (and optionally `PAYSTACK_ENVIRONMENT=production`), `MPESA_ENVIRONMENT`, and `APP_URL` (public HTTPS base used as the Paystack callback) on the Express server. `payment-complete.html` needs a Supabase session to poll status, so test the full loop on the Express host, not on Netlify/GitHub Pages.

## 2026-10-03 â€” Security fixes from an external code review (webhooks, payment API auth, Telegram bot)

An outside review of this repo listed ten concerns. I checked each against the real code; several were already fixed or were not real problems (the Supabase publishable key is meant to be public, the API uses bearer tokens so CSRF barely applies, the service worker only caches static pages). These five were real and are fixed here:

- **KCB webhook (the serious one):** the HMAC signature was only checked *if the caller sent a signature header*, so an attacker could omit it and forge a "payment succeeded" callback. The signature is now mandatory (missing or wrong = 401), the shared secret must be configured, and a callback whose timestamp is missing/invalid or older than 10 minutes is rejected (it used to only log a warning).
- **Paystack webhook:** a missing signature was accepted outside production, and a signature without a raw body skipped the check entirely. Both are now rejected in every environment.
- **Unauthenticated payment endpoints:** `/initiate`, `/status/:id`, `/link-sale`, `/gateways` and `/config` now need a signed-in business user; `/transactions`, `/recent` and `/transaction/:ref` need a business admin. The webhook callback routes stay open (the gateways call them) and rely on their signatures. `index.html`'s `safeFetchJson()` now attaches the Supabase token to every `/api/payments/` call automatically.
- **`payments/auth.js` hardcoded fallback key removed:** with no `SUPABASE_ANON_KEY` the protected endpoints now answer 503 instead of authenticating against an embedded key.
- **`telegram-bot.js` crashed on start** (`require()` in a `"type": "module"` package). Renamed to `telegram-bot.cjs`; run it with `node telegram-bot.cjs`.

**Tested** with Node scripts: KCB and Paystack accept a valid signed callback and reject missing/bad/stale ones; every protected route returns 401/503 without a session; callbacks stay reachable. **Not tested:** with a real browser session against a running Express server, or with real KCB/Paystack traffic. **Still open:** M-Pesa and Airtel callbacks have no signature (Safaricom does not sign; the fix is to confirm with Safaricom's status query before marking paid); payment records are not scoped per business, so one business's admin could read another's transactions on a shared Express server; the offline-login flag (`dogopos_is_logged_in`); and I did not read the `platform-admin` function that gates `/admin`.

**Follow-up fixes on this branch (the items listed above as "still open"):**
- **M-Pesa callbacks are now confirmed with Safaricom before anything is marked paid.** Safaricom does not sign callbacks, so anyone who knew a CheckoutRequestID could POST "ResultCode 0". A success claim now triggers Safaricom's own `stkpushquery`; if Safaricom does not confirm it, the request stays pending. The paid amount comes from our own request, not the callback body. A callback for a payment that is no longer pending is ignored (no replay, and a paid payment can't be flipped to failed). In production mode without live credentials a success claim is rejected. Sandbox/demo mode without credentials behaves as before. If Safaricom answers "still processing" the POS status poll (which already queries Safaricom) completes the payment moments later.
- **Airtel callbacks are refused in production.** `initiateAirtelPayment()` never contacts Airtel (it only creates a local record), so there is no real Airtel payment to confirm. Wiring a real Airtel collection + enquiry is a separate piece of work.
- **Payments are now separated per business.** `/initiate` stamps the `business_id` from the verified login (a client-supplied one is overwritten), and `/status`, `/link-sale`, `/transaction/:ref`, `/transactions`, `/recent` and `/simulate` only return a business's own payments. Seeded demo transactions have no owner and are no longer visible to real businesses.
- **Offline login restore no longer invents an admin.** When no session existed but the `dogopos_is_logged_in` flag and a cache were present, the app silently became "Allen Otiende", admin of business "default". It now restores only a profile that was cached from a real earlier sign-in (the cache now stores `id`, name, role and `business_id`). Devices that signed in before this update have no cached profile and will see the login screen once, until they sign in online again.
- **Not fixable from this repo:** the `platform-admin` edge function that protects `/admin` is not in the repository (there is no `supabase/functions` folder), so I could not review it. It needs checking inside Supabase.
- **Important finding:** of the four gateways, only M-Pesa actually calls a provider. KCB, Paystack and Airtel `initiate` only create a local record and never contact the provider, so the webhook hardening above protects endpoints for integrations that do not yet move real money.

**Deploy note:** set `SUPABASE_ANON_KEY`, `KCB_SHARED_SECRET` and `PAYSTACK_SECRET_KEY` on the Express server. KCB must send `x-kcb-signature` and a timestamp, or its callbacks will now be rejected.
## 2026-10-03 â€” Gateway simulator hidden from the public page; all 5 subscription tiers shown

**Bug: the "Gateway Webhook & Callback Simulator" and "M-Pesa Transaction Inspector" were visible at the bottom of the public landing page on phones.** Cause: the CSS that hides those two modals (and styles the whole gateway ledger) had been nested by mistake inside the `@media (min-width: 1024px)` "collapsed sidebar" block, so on any screen narrower than 1024px the modals had no `display:none` and rendered as plain unstyled blocks under the footer. Fixed by closing that desktop block right after the sidebar rules; the gateway styles now apply at every screen size.

**The simulator is now a platform-admin-only tool.** The "Simulate Webhook" button is hidden for everyone except the platform super admin, and `openSimulateTxModal()` refuses to open for anyone else, so a business user can no longer inject fake payment callbacks even by calling it from the console.

**Pricing now shows all 5 tiers** (it only showed Free, Core and Control): Free, Core POS (KES 999), **Core Group (KES 3,999, up to 5 branches)**, Control POS (KES 1,999), **Control Group (KES 7,999, up to 5 branches)**. The Monthly/Yearly toggle updates all four paid tiers (yearly: 9,999 / 39,999 / 19,999 / 79,999), and the sign-up plan picker offers the two group tiers too.

**Not done / caveats:** checked with jsdom tests (5 cards, toggle, plan picker) and syntax checks, not in a real browser, so please look at the landing page on your phone. A plan chosen at sign-up is still only a cosmetic/local hint: the plan the app actually enforces comes from the business's database row, and a 7-day trial is only written to the database from the in-app upgrade flow. The Free plan card and the sign-up flow itself are unchanged.

## 2026-10-02 â€” Restaurant: kitchen confirmation now goes straight to a hotel-style Clear Bill

You asked that, after the kitchen is confirmed, checkout should take the user directly to the bill and stop showing the retail-style "Settle Bills" screen (product grid plus "Current sale"), and that the bill should look like the hotel/table UI.

**What changed (`index.html`, Hotel/Restaurant businesses only):**
- **Mark served now opens Clear Bill.** On the Kitchen Board, confirming "Served & Clear Bill" no longer just deletes the ticket (which silently dropped an unpaid order). The ticket stays as an open bill and the app jumps straight to its Clear Bill screen.
- **Settle Bills is now a hotel-style screen.** It shows a list of open bills as tiles (same look as Floor Tables). Tapping one (or arriving from the kitchen) shows the same "Running check" card the table order screen uses: lines, then Total (VAT incl.). The retail product grid and the "Current sale" cart list are hidden in this mode.
- **Payment is unchanged.** Below the running check it reuses the existing shift banner, cash tender, and M-Pesa / KCB / Paystack / Airtel flow, with the ticket's items loaded as the cart (VAT, code and unit resolved from the catalog).
- **Paid tickets tidy themselves.** A served ticket is removed once paid. A ticket paid before serving is marked Paid and removed when it is served.
- **Shortcuts.** A "Clear bill" button was added on Kitchen Board tickets and on the Take Orders panel. A "Walk-in quick sale" button on the bill list gives access to the old retail layout when needed.

**Not done / caveats:** syntax-checked and the bill logic was tested in isolation (jsdom); the full screen has not been clicked through in a real browser or with a live M-Pesa payment. Kitchen tickets are still stored in browser localStorage (`dogopos_kitchen_tickets_v1`), so open bills are per device, not shared between devices.

## 2026-09-30 â€” Subscription plans are now actually enforced; security fixes from a code review

You asked to add 5 subscription tiers, lock businesses to them, route subscription payments to you, and restrict the Platform Console link to your account only. Investigating that surfaced a real, serious problem worth fixing before anything else: **the plan a business was on lived almost entirely in that browser's localStorage, which anyone could edit in their own browser console to grant themselves any plan for free** â€” and a "manual M-Pesa code" box on the upgrade screen accepted any 6+ character string as proof of payment and upgraded the account instantly, with zero verification. Five tiers already existed in the code (Free, Core, Core Group, Control, Control Group) â€” the real gap was that none of them were actually locked to anything.

**Requires a manual step â€” run `supabase/migrations/20260930_subscription_enforcement.sql`** in the Supabase SQL editor (after the branches migration from Sept 29, if you haven't already). It adds:
- Real columns on `businesses`: `subscription_status`, `subscription_renews_at`, `subscription_started_at`.
- A `subscription_claims` table: submitting a manual M-Pesa code now creates a pending claim instead of instantly granting a plan. Only your account (matched by email) can approve or reject one; approving it upgrades the business automatically, in the same transaction.
- A `platform_settings` table (one row, your account only) replacing the old localStorage-only "Payout & Gateway Settings" in the Admin Console â€” now genuinely persisted, not tied to one browser.
- **The actual lock**: database triggers that block adding a team member past the plan's `maxUsers`, a branch past `maxBranches`, or a product past `maxProducts` (Free only) â€” enforced by Postgres itself, not just the UI, so it can't be bypassed by editing the browser or calling the API directly.

**Frontend changes to match:**
- `getCurrentBusinessPlan()` (index.html) now reads only `business.subscription_plan/status/renews_at` from the database â€” localStorage is no longer consulted for what plan you're on.
- A confirmed M-Pesa STK payment or a free-trial activation now writes the grant to the database (previously: in-memory + localStorage only, never actually saved).
- The manual-code box now submits a claim and tells the customer it's pending verification, instead of upgrading them immediately.
- `team.html`: Add Teller/Add Branch show a friendly warning when a plan's limit is reached, backed by the real database trigger either way.
- Admin Console (`admin/index.html`): Pending Verifications and Subscription History now read/write the real tables; Approve/Reject actually changes the business's plan. Removed the part of "Save Payout Settings" that tried to sync Daraja credentials into the same `mpesa-settings` edge function a business uses for its own till â€” that risked attaching your subscription-collection credentials to whichever business happened to be active in the session, rather than a truly separate platform destination.

**Platform Console access (your other ask, done):** the public marketing page's header no longer links to `admin/index.html` at all. The sidebar link inside the app now only appears when both are true: the account is a real platform admin (server-verified) AND its email matches your account specifically â€” a regular business Owner/Admin will never see it, even though the underlying `data-admin-only` toggle they still use for their own Team/Settings tabs is unrelated to this.

**Still open â€” I need something from you:** subscription STK-push payments currently go through the same `mpesa-stk-push` edge function a business uses for its own sales, which is designed around *that business's own* Till/Paybill credentials. I cannot rule out â€” and given how the code calls it, I think it's likely â€” that clicking "Send M-Pesa STK Push" on the upgrade screen would charge to the *business's own till*, not yours. I can't fix this from here: it needs either your own dedicated Daraja app credentials wired into a genuinely separate edge function (I can write that code for you to deploy, the same way as the SQL migrations), or the STK button removed from the upgrade screen in favor of the manual-code-plus-your-approval flow, which is safe today. Two things I need from you: **(1)** which of those two you want, and **(2)** if the dedicated function, your Till/Paybill number and confirmation you have your own Daraja app credentials to use.

**Also fixed, found while addressing an external code review someone ran against this repo:**
- Three places built an inline `onclick="..."` handler out of free-text business data (product name, category, and in one case a product code) using only HTML-escaping. HTML-escaping alone doesn't protect an inline event handler, because the browser parses that attribute as HTML *and then* as JavaScript â€” escaping for the first doesn't make it safe for the second. A product or menu item named something like `x');alert(1);//` would have run arbitrary JavaScript in that session. Replaced all three (`rcProductsGrid`/POS grid, `orderItemGrid`/table order screen, `restProductGrid`/restaurant menu grid) with `data-*` attributes read by a delegated click listener instead â€” this removes the double-escaping problem entirely rather than trying to escape harder. Not yet re-tested by hand in a browser; syntax-checked only.
- Found and fixed a second, separate spot with the demo-catalog fallback from yesterday: `renderRestProductGrid` (the Hotel/Restaurant order screen) had its own copy of the same "show fake sample items when the real catalog is empty" logic, missed in yesterday's fix because it wasn't behind `getEffectiveCatalog()`. Now always shows the business's real (possibly empty) menu.
- `telegram-bot.js` had a hardcoded fallback Supabase key, same pattern fixed in the payment gateway files on Sept 28 â€” now fails loudly if the env var is missing instead of silently using an embedded value.
- Added a small in-memory rate limiter to the Express payments router (`payments/index.js`) â€” 30 requests/minute per IP by default. Not a substitute for real rate limiting at a CDN/edge if this server is ever deployed publicly, but stops naive spam against payment endpoints today.
- Reviewed and did **not** change: the public Supabase anon key hardcoded in several files (this is the intended "publishable" key â€” safe by design as long as RLS policies are correct, not a secret); the `/admin` static route in `server.js` (it serves the HTML shell to anyone, but everything inside it requires a real Supabase session and the same email/RLS checks described above â€” matches the security model used everywhere else in this app, so adding a second gate here would be redundant, not a fix); CSRF (the payment endpoints require a Bearer token in a header, which a browser never attaches automatically cross-site, so the classic CSRF vector doesn't apply here the way it would to cookie-based auth).

## 2026-09-29 â€” Clear Bill on Menu & Tables; new accounts no longer see demo products

**Clear Bill (`tables.html`)**
- "Checkout (cash)" replaced with **Clear Bill**: a payment screen with the same method choices as the Sales page (Cash, M-Pesa, plus KCB/Paystack/Airtel when an Express API is configured).
- Digital payments send a real request and only clear the table once the gateway confirms the exact amount â€” identical engine to `sell.html` (72s wait with countdown, resumes if the page is closed mid-payment, one payment can't be recorded twice, a paid-but-unrecorded failure keeps the reference and offers Retry).
- Requires an open shift, same as the classic app's checkout â€” points to the Sales page if none is open, and no longer offers an unauthenticated cash shortcut.
- Tested with mocked data: cash, confirmed M-Pesa, cancelled M-Pesa, and the no-open-shift case all behave correctly (see repo history for the manual test transcript). Not yet tested against a real M-Pesa sandbox or Supabase data.

**New accounts no longer get demo data**
- Found the cause of the sample products (Ajab Flour, Claw Hammer, etc.) appearing in a brand-new account: `index.html`'s `getEffectiveCatalog()` silently substituted a hardcoded starter catalog (`DEFAULT_RETAIL_PRODUCTS` / `INDUSTRY_CONFIG[type].products`) into the Sell screen whenever the business's real `products` table was empty. Nothing was ever written to the database â€” this was a display-only substitution â€” but it made an empty account look pre-populated, and `posCardClick`/barcode lookup could "sell" one of these fake items.
- Removed the fallback: `getEffectiveCatalog()` now always returns the business's real products, empty or not. A genuinely empty catalog now shows an honest "No products yet â€” add your first product" state with a button straight to Add Product, instead of fake inventory.
- The logged-out marketing landing page's own interactive demo widget (`getActiveDemoProducts`, `demoAddToCart`) is untouched â€” it never touched real account data and still shows sample products to visitors before they sign up, which is the right place for demo data to live.
- The new multipage pages (`catalog.html`, `sell.html`, `tables.html`) were never affected by this â€” they only ever read the real `products` table and already showed a genuine empty state.

## 2026-09-29 â€” Team: branches, managers; Restaurant/Hotel on the new layout

**Team & Branches (`team.html`, rewritten)**
- Admin can add a **branch** (name + optional location) and deactivate/reactivate one.
- Admin can create a teller **or manager** account (via the existing `create-teller` edge function), and assign a branch at creation or later from the Team list.
- Team list: change anyone's role (Teller â‡„ Manager) or branch assignment inline, deactivate/reactivate anyone but yourself.
- Requires a small database change the app itself cannot make (only holds the publishable key): **`supabase/migrations/20260929_branches_and_manager_role.sql`** â€” adds a `branches` table and `profiles.branch_id`, with RLS scoped to `current_business_id()`. Run it once in the Supabase SQL editor. Until then, the Team page still works (add/edit tellers, roles) and shows a plain notice instead of the Branches table.
- **Scope note:** a Manager's branch assignment is not yet enforced anywhere else â€” sales, products, expenses etc. stay visible business-wide, same as today. This migration only adds the ability to organize the team by branch; branch-scoped data isolation across the rest of the app is a separate, larger change if you want it next.

**Restaurant/Hotel on the new layout (`tables.html`, new)**
- Table grid (free/occupied, running total), add/remove tables.
- Tap a table for an order screen: category chips, item grid with tap-to-add, running check, quantity +/âˆ’.
- **Send to kitchen** (printable ticket, same as the classic app's KOT). **Checkout (cash)** runs the same `process_sale` RPC as every other page and clears the table.
- M-Pesa and other digital payment on a table order is not built here yet â€” noted in the page, with a pointer to the Sales page as a workaround.
- The new look is now the default for Hotel/Restaurant businesses too (the earlier exclusion in `index.html` is removed), since Menu & Tables now covers what they need. Opening `tables.html` on a non-Hotel/Restaurant business shows a message instead of an empty page.
- Nav: "Menu & Tables" only appears for businesses whose type is Hotel or Restaurant (`assets/js/app-shell.js`, `assets/js/dogo-data.js`).

**Tested with mocked data only** (Playwright): team page with and without the branches table present, adding a branch, table order â†’ checkout â†’ `process_sale` call â†’ table cleared. Not yet tested against your real Supabase/data â€” please run the migration, then try adding a branch, creating one teller and one manager, and settling one real table order before relying on this.

## 2026-09-28 â€” New look is the default, hardened (merged with commits b9191a6 â†’ e0762c7)

Another set of commits landed on `main` while this was being built (Purchases, Inventory, Loans, Equity, Fixed Assets pages, a neon-green/white/gold theme, shift open/close on the Sales page, Settings ported to the new layout, Zoho removed). Those were kept as-is; the changes below were re-applied on top of them.

**Default entry point**
- Signing in lands on `dashboard.html`; `server.js` serves `dashboard.html` at `/` and the classic app at `/legacy`.
- Replaced the unconditional redirect in `index.html` (`afterLogin`) with a conditional one. The classic app stays the default for **Hotel/Restaurant businesses** (their table/menu modules are not migrated) and for **platform admins currently "testing as" another business**.
- Fast path: returning users are redirected from a tiny script in `<head>` (`dogo_new_ui_ok` flag), so the classic UI never flashes.
- `?legacy=1` opens the classic app for that tab (`sessionStorage.dogo_legacy`); the "Main Dashboard" sidebar link clears it.
- **Redirect-loop protection:** if the new pages find no valid session or profile they sign out, clear the flag and go to `index.html?signin=1`, which never redirects. Sign-out clears both flags.
- New pages look the business up by `profile.business_id` (was `limit(1)`, which could pick the wrong business for platform admins).
- `service-worker.js`: cache `v6`, all pages and `assets/` added to the offline cache.

**Files:** `index.html`, `assets/js/dogo-data.js`, `service-worker.js`, `team.html` link.

## 2026-09-28 â€” Digital payments on the Sales page

Previously choosing "M-Pesa" on the new Sales page simply recorded the sale as paid, with no request sent and nothing verified. Now:
- **M-Pesa STK push** through the existing `mpesa-stk-push` Supabase edge function; polls `payment_requests` every 2 s for up to 72 s with a live countdown and Cancel.
- KCB Buni, Paystack and Airtel Money appear in the method list only when an Express payments API is configured (`dogo_api_url` or localhost); hosted sites cannot reach that server.
- The sale is recorded only after the gateway reports `success` **and** the confirmed amount matches the cart (Â±0.01).
- `p_offline_uuid` = the payment request id, so one payment can never be recorded twice.
- If the page is closed or refreshed while waiting, the pending payment resumes on next load (`dogo_pending_payment_v1_<user>`).
- Paid-but-not-recorded failures show the payment reference and a **Retry recording** button instead of losing the sale.
- Receipt modal with print; `etims-submit` fires after each digital sale (as in the classic app).
- Cart, method picker and product grid are locked while a payment is pending.
- Credit sales now require a customer. Card-terminal and credit still record immediately (no gateway to verify against).
- Shift bar, open/close-shift modals and reconciliation from the remote version are unchanged.

**Files:** `sell.html`.

## 2026-09-28 â€” Multipage rebuild (commits c4809a1, c4aa087, 68efd9a)

- New shared design system modelled on the DigiKua reference: orange header, rounded icon nav grid, white cards, fully responsive (`assets/css/theme.css`).
- Shared shell and data layer: `assets/js/app-shell.js` (header + nav), `assets/js/dogo-data.js` (Supabase client, session check, toast, CSV download).
- New pages: `dashboard.html` (Overview), `catalog.html` (Products + Inventory), `customers.html` (Contacts), `sell.html` (Sales), `expenses.html`, `reports.html` (daily / monthly / sales log + CSV download + print), `team.html`, `settings.html`.
- Added afterwards by the remote commits: Purchases, Inventory, Loans, Equity, Fixed Assets. Still only in the classic app: Hotel/Restaurant modules, staff invites, KCB/Paystack/Airtel checkout on hosted sites (needs the Express server).

## 2026-09-28 â€” Security fixes (commit 6f46dae)

- `payments/store.js`: removed hardcoded fallback webhook secrets (KCB, Paystack, Airtel). Missing env vars now generate a random per-process value with a boot warning. The M-Pesa passkey fallback stays: it is Safaricom's public sandbox passkey.
- `payments/auth.js` (new): `requireBusinessAdmin` verifies a real Supabase session with `profiles.role = 'admin'`.
- `POST /api/payments/simulate/:id` and `POST /api/payments/config/:gateway` now require it (they were open to anyone). Simulate also refuses gateways in production mode.
- Fixed the classic app calling a non-existent `/simulate-callback` route.
- `config/secrets/.env.example` documents every env var; `config/secrets/` is gitignored.

### Known open items
- Express payment requests are not tagged with `business_id` (admin check proves *an* admin, not the owning business's admin) â€” fine while single-tenant/local.
- ~100 of 125 `innerHTML` sites in classic `index.html` have not had the `escapeHtml()` pass.
- The classic app and the new Sales page record digital sales client-side after polling; moving completion into the payment webhook would remove the reliance on the browser staying open.
