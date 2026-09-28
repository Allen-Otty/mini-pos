# Dogo POS — Changelog

Newest first. Each entry lists what changed and why, so nothing has to be rediscovered from the git log.

## 2026-09-28 — New look is the default, hardened (merged with commits b9191a6 → e0762c7)

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

## 2026-09-28 — Digital payments on the Sales page

Previously choosing "M-Pesa" on the new Sales page simply recorded the sale as paid, with no request sent and nothing verified. Now:
- **M-Pesa STK push** through the existing `mpesa-stk-push` Supabase edge function; polls `payment_requests` every 2 s for up to 72 s with a live countdown and Cancel.
- KCB Buni, Paystack and Airtel Money appear in the method list only when an Express payments API is configured (`dogo_api_url` or localhost); hosted sites cannot reach that server.
- The sale is recorded only after the gateway reports `success` **and** the confirmed amount matches the cart (±0.01).
- `p_offline_uuid` = the payment request id, so one payment can never be recorded twice.
- If the page is closed or refreshed while waiting, the pending payment resumes on next load (`dogo_pending_payment_v1_<user>`).
- Paid-but-not-recorded failures show the payment reference and a **Retry recording** button instead of losing the sale.
- Receipt modal with print; `etims-submit` fires after each digital sale (as in the classic app).
- Cart, method picker and product grid are locked while a payment is pending.
- Credit sales now require a customer. Card-terminal and credit still record immediately (no gateway to verify against).
- Shift bar, open/close-shift modals and reconciliation from the remote version are unchanged.

**Files:** `sell.html`.

## 2026-09-28 — Multipage rebuild (commits c4809a1, c4aa087, 68efd9a)

- New shared design system modelled on the DigiKua reference: orange header, rounded icon nav grid, white cards, fully responsive (`assets/css/theme.css`).
- Shared shell and data layer: `assets/js/app-shell.js` (header + nav), `assets/js/dogo-data.js` (Supabase client, session check, toast, CSV download).
- New pages: `dashboard.html` (Overview), `catalog.html` (Products + Inventory), `customers.html` (Contacts), `sell.html` (Sales), `expenses.html`, `reports.html` (daily / monthly / sales log + CSV download + print), `team.html`, `settings.html`.
- Added afterwards by the remote commits: Purchases, Inventory, Loans, Equity, Fixed Assets. Still only in the classic app: Hotel/Restaurant modules, staff invites, KCB/Paystack/Airtel checkout on hosted sites (needs the Express server).

## 2026-09-28 — Security fixes (commit 6f46dae)

- `payments/store.js`: removed hardcoded fallback webhook secrets (KCB, Paystack, Airtel). Missing env vars now generate a random per-process value with a boot warning. The M-Pesa passkey fallback stays: it is Safaricom's public sandbox passkey.
- `payments/auth.js` (new): `requireBusinessAdmin` verifies a real Supabase session with `profiles.role = 'admin'`.
- `POST /api/payments/simulate/:id` and `POST /api/payments/config/:gateway` now require it (they were open to anyone). Simulate also refuses gateways in production mode.
- Fixed the classic app calling a non-existent `/simulate-callback` route.
- `config/secrets/.env.example` documents every env var; `config/secrets/` is gitignored.

### Known open items
- Express payment requests are not tagged with `business_id` (admin check proves *an* admin, not the owning business's admin) — fine while single-tenant/local.
- ~100 of 125 `innerHTML` sites in classic `index.html` have not had the `escapeHtml()` pass.
- The classic app and the new Sales page record digital sales client-side after polling; moving completion into the payment webhook would remove the reliance on the browser staying open.
