# Dogo POS — Documentation

A multi-business point-of-sale web app: cloud sync, role-based Admin/Teller accounts, offline sales, KRA VAT-ready reporting, and M-Pesa payments.

**Live app:** https://allen-otty.github.io/mini-pos/
**Backend:** Supabase project `mini-pos-backend` (id: `uzwomzkzqrpiumtnniik`)
**Source code:** https://github.com/Allen-Otty/mini-pos

> **Status note (2026-08-30):** this README describes what is *confirmed* built by direct inspection of the real code and live database. See `TASKS.md` for exactly what's in progress. This revision reconciles two sessions that were working on the same live repo in parallel (this one, and an earlier Claude Code session). Git log confirmed both sessions independently applied the same restaurant table-order patch; the other session's version had pushed first and was slightly more robust in two spots (safer onclick-attribute escaping), so that version was kept as the base with this session's exclusive work (Neon Dusk theme, signup/password hardening, security fixes) layered on top and reconciled by hand rather than a raw git merge.

---

## 1. What's confirmed working (frontend + backend both wired, verified by reading the real code)

- **Multi-tenant auth**: Sign Up (email OTP, duplicate-email handling) → Create Business, Sign In (with show/hide password toggle, confirm-password, password rules), Admin/Teller roles — via `create-business`, `create-teller`, `secure-login` edge functions
- **Sell tab**: camera barcode scanning, manual entry, cart, VAT-inclusive pricing
- **Checkout**: Cash, or M-Pesa via STK Push — wired to the real Supabase project (`mpesa-stk-push`, `mpesa-callback`, `mpesa-settings` edge functions; `payment_requests` table)
- **Shift management**: `openShift()`/`closeShift()`, opening float, expected vs actual cash, variance tracking, shifts history table
- **Menu & Tables** (Hotel/Restaurant only): **redesigned to a table-first order flow** — tap a table → category-chip menu → running check → Send to Kitchen (prints a KOT) / Checkout Table (clears the table back to Free). Live — see Section 2 for reconciliation notes
- **Signup/Login hardening**: duplicate-email detection with a link to Sign In, Confirm Password field, show/hide password toggle (login + signup), password rules checklist (8+ chars, upper/lower/number) — live
- **Neon Dusk theme** (`#00d4ff` / `#020024`) applied as the new default palette — live
- **Platform Admin**: in-app business switcher (`checkPlatformAdminStatus()`, `renderPlatformSwitcher()`) AND a separate full console at `/admin/index.html` — business suspend/reactivate/delete, promote/demote admins, stats dashboard
- **eTIMS Settings**: save/status/remove KRA PIN/Branch ID; every sale fires a non-blocking `etims-submit` call
- **Dashboard, Sales Log, Customers, Reports, Expenses, Catalog, Team, Settings** tabs
- **Offline selling**: sales queue in `localStorage` (correctly scoped to just the sync queue + cache, not full app state), auto-sync on reconnect
- **Row Level Security**: every table scoped to `business_id`

### Business types
Retail Shop / Wholesale / Supermarket / SME / Hotel-Restaurant / Hardware Store — live in the UI dropdown. The database constraint was expanded to also accept Kiosk / Restaurant / Pharmacy / Service as separate values, but the frontend dropdown doesn't offer them — by design, since bars are meant to use the existing Hotel/Restaurant type rather than get a new one.

## 2. In progress — Restaurant Menu & Tables redesign

Table → build an order → send to kitchen → pay:

- Table-first flow: tap a table → category-chip menu → running check per table
- Kitchen Order Ticket printing (reuses the existing receipt `window.print()` pattern)
- Table auto-clears to Free after checkout
- **Status: live.** Two independent implementations of this patch were found during reconciliation (this session's and an earlier Claude Code session's) — the earlier one had already been pushed and was kept as the base since it was slightly more defensive against special characters in `onclick` attributes; this session's exclusive work (theme, password hardening) was layered on top by hand. Backend columns (`tables.current_order`, `sales.table_id`) are live. Known gap carried over from the original patch: `checkout()`/`pushSaleToServer()` still doesn't tag the resulting sale with `table_id`, so table-linked sales won't show that link in reporting yet — small non-blocking follow-up.
- **Open question raised with the user:** the database's `business_type` CHECK constraint allows `'Hotel'`, `'Restaurant'`, `'Pharmacy'`, and `'Service'` as four separate values, but the signup/settings UI dropdown only ever offers a single combined "Hotel / Restaurant" option (stored as `'Hotel'`). The Menu & Tables gate checks for exactly `business_type === 'Hotel'`, so it's internally consistent with the current dropdown — but `'Restaurant'`, `'Pharmacy'`, `'Service'` exist in the database with no UI path to select them and no defined behavior if they were ever set directly. Not resolved — see questions.

## 3. How VAT works in this app

Prices entered are the final, VAT-inclusive selling price — exactly what the customer pays. VAT is extracted backward for KRA record-keeping, never added on top at checkout:

```
VAT amount = price − (price ÷ (1 + VAT rate))
```

Example: KES 116 at 16% VAT → VAT = KES 16.00, excl-VAT = KES 100.00. Customer still pays exactly KES 116.

## 4. Data model (confirmed live via direct schema inspection)

| Table | Purpose |
|---|---|
| `businesses` | One row per registered business |
| `profiles` | One row per user, `role` = admin/teller |
| `products` | Catalog — VAT-inclusive price |
| `customers` | Per-business customer list |
| `sales` / `sale_items` | Sale headers/lines. `sales` has `table_id` (column live; not yet written by checkout — see Section 2) |
| `expenses` | Business costs — Admin only |
| `tables` | Hotel/Restaurant table management. `current_order` (JSONB) now drives the live table-first order flow (Section 2), not just Free/Occupied toggling |
| `shift_sessions` | Till open/close, float, variance — has working frontend |
| `mpesa_settings` / `mpesa_settings_status` | Per-business M-Pesa credentials (locked table + safe status view) |
| `etims_settings` / `etims_settings_status` | Per-business KRA credentials — has working frontend |
| `etims_submissions` | Built KRA fiscalization payloads |
| `platform_admins` / `platform_active_business` | Platform-owner list + active business-switch state — has working frontend (in-app + `/admin`) |
| `login_history`, `audit_log` | Security/audit logging |
| `payment_requests` | M-Pesa STK push tracking |

**Views:** `low_stock_items`, `platform_stats`, `mpesa_settings_status`, `etims_settings_status`

**Edge Functions (all `ACTIVE`):** `create-business`, `create-teller`, `secure-login`, `platform-admin`, `mpesa-settings`, `mpesa-stk-push`, `mpesa-callback`, `etims-settings`, `etims-submit`, `platform-switch-business`

## 5. Known issues

See `TASKS.md` for the full, maintained list. Headline items:
- **Fixed this session:** `checkout()` now calls the atomic `process_sale` RPC (row-locks stock, no more oversell race); RPC extended to accept `payment_method`/`shift_id`/`mpesa_receipt_no`; `low_stock_items` view's real `SECURITY DEFINER` cross-tenant leak fixed (confirmed via `reloptions`, not just the advisor flag); `search_path` pinned on 5 more functions; `anon` execute revoked from two pure-trigger functions
- **Still open:** `is_admin()`/`is_platform_admin()`/`business_is_active()` remain callable by the unauthenticated `anon` role — not yet resolved, since revoking could break RLS policies that reference them; needs the user's confirmation on intended pre-auth use before touching
- **Still open:** duplicate permissive RLS policies on `businesses` (member vs platform-admin, for SELECT and UPDATE) — cosmetic performance note only, deliberately left alone rather than risk breaking access
- **Still open:** leaked-password protection in Supabase Auth settings — dashboard-only toggle, needs the user to do it directly
- **Still open:** ~20 unindexed foreign keys — fine at current scale

## 6. Hosting & deployment

- Live link: GitHub Pages — `https://allen-otty.github.io/mini-pos/` — every push to `main` auto-rebuilds within 1–2 minutes. (Previously went down silently when Pages got disabled on the repo — confirmed re-enabled and working as of 2026-08-29.)
- Netlify site (`dogo-pos`) created but not yet deployed

```bash
git clone https://github.com/Allen-Otty/mini-pos.git
# make changes
git add -A
git commit -m "describe the change"
git push origin main
```

## 7. Security notes

- Browser only ever holds a publishable Supabase key — RLS enforces the rest
- Service-role keys only used inside Edge Functions, never in the browser
- M-Pesa/eTIMS credentials stored in tables that block all direct reads — only their dedicated edge functions (service-role) can touch them
- `current_business_id()` must always be `SECURITY DEFINER` — a past migration accidentally dropped this and silently broke login app-wide; confirmed fixed and currently `SECURITY DEFINER = true` as of this revision
