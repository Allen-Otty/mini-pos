# Dogo POS — Task Tracker

> **Rule:** this file is updated after every change made to the system (frontend, backend, or docs). Checked = verified done. Unchecked = still open. Each entry notes how/where it was verified, not just claimed.

Last updated: 2026-08-31

---

## ✅ Completed (verified)

### Backend — database
- [x] Confirmed live schema directly via Supabase connector (17 tables, 4 views, 10 edge functions, 6 helper functions) — not assumed from docs
- [x] Expanded `businesses.business_type` constraint to add Kiosk / Restaurant / Pharmacy / Service, on top of existing Retail/Wholesale/Supermarket/SME/Hotel/Hardware
- [x] Added `process_sale` atomic RPC — single-call checkout: inserts sale + items, row-locks and decrements product stock, blocks overselling, idempotent on `offline_uuid` for safe offline-sync retries
- [x] Fixed security bug in `process_sale`: was callable by anonymous/unauthenticated users on first deploy — revoked from `anon`/`PUBLIC`, restricted to `authenticated`

### Investigation / audits
- [x] Ran Supabase security advisor — found 1 ERROR + 8 WARN issues (see Open Issues below)
- [x] Ran Supabase performance advisor — found ~20 unindexed foreign keys + duplicate permissive RLS policies on `businesses`
- [x] Confirmed via direct fetch that the live app at allen-otty.github.io/mini-pos references the real Supabase project (`uzwomzkzqrpiumtnniik`) in its M-Pesa callback URL — M-Pesa wiring is real, not a stub
- [x] Confirmed the previously-uploaded `MiniPOS_PWA.zip` does **not** match the live site (zero Supabase/M-Pesa/Shift references in that file) — do not use it as a source of truth

---

## 🚧 Open — Backend

- [ ] Fix `low_stock_items` view — currently `SECURITY DEFINER`, bypasses RLS (ERROR level)
- [ ] Review 4 functions callable anonymously as `SECURITY DEFINER`: `is_admin`, `handle_new_user`, `is_platform_admin`, `business_is_active` — confirm intentional or lock down
- [ ] Set explicit `search_path` on 6 functions with mutable search_path (`current_business_id`, `is_admin`, `handle_new_user`, `is_platform_admin`, `protect_primary_owner`, `business_is_active`)
- [ ] Enable leaked-password protection in Supabase Auth settings (1-click, dashboard-only)
- [ ] Add covering indexes for ~20 unindexed foreign keys (sales, sale_items, expenses, shift_sessions, etc.)
- [ ] Resolve duplicate permissive RLS policies on `businesses` (`_select_member` + `_select_platform_admin`, `_update_admin` + `_update_platform_admin` overlap for same role/action)

## ✅ Corrected — Frontend (previous entries below were wrong, based on a stale zip + text-only fetch)

- [x] Obtained the real, current repo (`mini-pos-main.zip`, 2,342-line `index.html` + `admin/index.html` + `_headers`) — confirmed via direct file inspection, not text-extraction guesswork
- [x] Confirmed Shift open/close is fully implemented (`openShift()`, `closeShift()`, shift banner, shifts table) — wired to `shift_sessions`
- [x] Confirmed Menu & Tables is fully implemented (`renderMenuTab()`, `addTable()`, `toggleTableStatus()`, `removeTable()`) — wired to `tables`
- [x] Confirmed Platform Admin switcher is fully implemented in-app (`checkPlatformAdminStatus()`, `renderPlatformSwitcher()`) AND as a separate full admin console at `/admin/index.html` (business suspend/reactivate/delete, promote/demote admins, stats dashboard) — neither of these was known about before this file was uploaded
- [x] Confirmed eTIMS Settings is fully implemented (`loadEtimsStatus()`, `saveEtimsSettings()`, `removeEtimsSettings()`, fire-and-forget `etims-submit` call on every sale)
- [x] Confirmed `localStorage` is correctly scoped to just the offline cache + sync queue, not full app state (unlike the earlier stale zip)

**Correction:** the "backend built, frontend pending" framing in the previous README/TASKS revision was incorrect for all four features above. That assessment was made from a stale zip file and a text-only page fetch, neither of which could see real app logic. Treat this file as the source of truth going forward, not that earlier version.

## 🚧 Open — Frontend (real gaps, found by reading the actual checkout code)

- [ ] **`checkout()`/`pushSaleToServer()` is non-atomic**: does 3 separate calls (insert sale → insert sale_items → loop-update stock per item), no row locking. Two devices selling the same low-stock item concurrently could both succeed and oversell. The `process_sale` RPC (already deployed) fixes this — checkout just needs to call it instead.
- [ ] **`process_sale` RPC doesn't accept `payment_method`, `mpesa_receipt_no`, or `shift_id`** — found by checking the real `sales` table schema just now. `payment_method` defaults to `'cash'` so cash sales would work, but M-Pesa sales and shift-linked sales would silently lose that data if routed through the RPC as currently written. RPC needs updating before checkout can safely switch to it.
- [ ] If checkout switches to the RPC, decide how to handle an "insufficient stock" RPC error — currently any `pushSaleToServer` failure gets queued for offline retry, which would retry a genuine stock shortfall forever. Needs a distinct error path.

## 🚧 Open — Unresolved issues

- [x] **Live-site 404** — RESOLVED and confirmed by the user. Root cause: GitHub Pages was silently disabled, so commits weren't deploying. Re-enabled in a parallel session; user confirmed the live site now loads with no more 404s.

## 🚧 Open — Documentation

- [x] README.md rewritten to reflect only verified-true state (see `README.md` in this delivery)
- [ ] Once frontend parity work lands, update README's "Known limitations" table to move completed items out

---

## ✅ Completed — from a parallel session (Claude Code, real deploy access)

> Reported by the user via screenshots. **Reconciled this session against actual git log**: only one set of frontend commits has ever landed on `main` (all from this chat session, ending at `15252b0`) — the parallel session's frontend claims below were real local/diagnostic work but had NOT reached git. The DB-level fixes it made ARE live (idempotent, independently reconfirmed below), so nothing was lost or conflicted.

- [x] **404 root cause found and fixed**: GitHub Pages was silently disabled — re-enabled, confirmed live (user confirmed no more 404s)
- [x] **Critical login bug fixed**: `current_business_id()` had lost `SECURITY DEFINER` in a prior migration, silently breaking all profile lookups. **Reconfirmed live** — `prosecdef = true`

### Reconciled this session (2026-08-30)
- [x] Neon Dusk theme (`#00d4ff` / `#020024`) — was only diagnosed/described previously, not actually in any pushed commit. **Applied for real** to the local working file in this session (`:root` vars, active-tab, `.btn-blue`, theme picker options)
- [x] Signup hardening (duplicate-email → link to login, confirm-password field, show/hide toggle on login + signup, password rules checklist) — same situation: described but not previously pushed. **Applied for real** to the local working file this session
- [ ] Checkout-button animation (from a reference video) — user is sending a screenshot since video can't be played directly; not yet resolved

## 🚧 Open — Restaurant Menu & Tables redesign

- [x] Backend: `tables.current_order` (JSONB) and `sales.table_id` (UUID) — confirmed live
- [x] Frontend: table-first order flow, Kitchen Order Ticket printing, table auto-clear on checkout — **all 4 patches from `restaurant_pos_patch.md` applied to the local working `index.html` this session** (CSS, Menu&Tables markup, `#kotModal`, and the full JS rewrite of `renderMenuTab()`/table functions), adapted to also run every user-supplied string through `escapeHtml()` for XSS safety (the original patch didn't). Syntax-checked clean. **Not yet pushed to git** — pending user review of the open questions below.
- [ ] Known gap carried over from the patch: `checkout()`/`pushSaleToServer()` still doesn't tag sales with `table_id` — small non-blocking follow-up
- [ ] **Open question, not resolved**: DB allows `business_type` = `'Restaurant'`/`'Pharmacy'`/`'Service'` as distinct values from `'Hotel'`, but the UI dropdown only offers a combined "Hotel / Restaurant" (stored as `'Hotel'`), and the Menu & Tables gate checks for exactly `'Hotel'`. Internally consistent as-is, but the three unused DB values need a decision: remove them from the constraint, or wire up real UI/behavior for them.

## 🚧 Open — Backend security (this session)

- [x] **Real bug found and fixed**: `low_stock_items` view had no `security_invoker`, silently bypassing RLS — confirmed via `pg_class.reloptions` (not just the advisor flag) that it was leaking every business's low-stock items to any authenticated user. Fixed: `security_invoker = true` added.
- [x] Pinned `search_path = public` on `is_admin()`, `is_platform_admin()`, `business_is_active()`, `handle_new_user()`, `protect_primary_owner()`
- [x] Revoked `anon` EXECUTE on `handle_new_user()` and `protect_primary_owner()` — confirmed pure-trigger functions, nothing legitimate calls them directly
- [ ] `is_admin()`/`is_platform_admin()`/`business_is_active()` still `anon`-callable — deliberately left alone this session since they're likely referenced inside RLS policies evaluated for the `authenticated` role, and revoking from `anon` without fully tracing every policy risks breaking login/checkout. Needs the user's go-ahead before touching.
- [ ] Duplicate permissive RLS policies on `businesses` — confirmed these are two legitimate, distinct policies (regular member vs platform admin) OR'd together, not a bug. Performance-only, left as-is.
- [ ] Leaked-password protection — dashboard-only Supabase Auth setting, needs the user to toggle it directly (can't be done via SQL/API)

## ✅ Completed (2026-08-31 session)

- [x] Netlify deployment made live at `dogo-pos-app.netlify.app` — site created via Netlify MCP connector, visitor SSO-login requirement disabled (was blocking public access), linked to `Allen-Otty/mini-pos` main branch for continuous deployment. Verified live (user confirmed).
- [x] Fixed real barcode-scanning bug: EAN-13 codes were being misread as UPC-A (dropping the implicit leading digit — e.g. `6197800022728` read as `197800022728`), causing already-catalogued items to wrongly trigger "new item" on every scan. Root-caused by extracting frames from a user-submitted screen recording via `ffmpeg` (video can't be played directly) and cross-checking against Sales Log evidence of the same item appearing under two different receipts. Fixed two ways: restricted `formatsToSupport` to actual retail symbologies, and added a fallback match in `findProduct()` for the specific leading-digit-drop case.
- [x] Fixed real bug: "Resend Code" button had no debounce — Supabase auth logs showed it firing twice, 1 second apart, sending two OTPs and leaving the user unsure which was current. Added a 30s cooldown with the button disabled during it.
- [x] Diagnosed the OTP `otp_expired` bug precisely via direct Supabase auth log inspection (not guessing): verify attempts failing 18–52 seconds after signup, `type: 'signup'` confirmed correct in code, user confirmed the dashboard's OTP expiry setting genuinely shows 3600s saved. Conclusion: Supabase-side config propagation issue, not fixable from our code or dashboard. **User's decision: leave OTP as-is for now** rather than pursue a fix (options discussed: custom self-hosted OTP, magic link, SMS OTP — all declined for the moment).
- [x] Noticed but not yet fixed: every Supabase auth log entry shows `referer: http://localhost:3000` — flagged for the user to check Authentication → URL Configuration → Site URL is set to the real production domain.
- [x] Built full dual-theme system: Neon Dusk (default) and Till Paper (warm/high-contrast/squared buttons), CSS custom-property token system in `:root` and `[data-theme="paper"]`, toggle in header + Settings + pre-login screen, `localStorage` persistence, anti-flash-of-wrong-theme script. **Caught and fixed a real bug introduced mid-build**: used invalid JS-ternary syntax directly in CSS (`color: [data-theme="paper"] ? x : y`) in three places — not valid CSS, would have silently failed. Fixed with proper `[data-theme="paper"]` override rules before pushing. Verified CSS brace balance and full JS syntax check before push.
- [x] Replaced all 62 emoji instances (29 unique) with real Font Awesome icons, loaded from cdnjs. Caught one collateral bug from the blanket find-replace (an emoji inside a CSS `content:` property became invalid HTML-in-CSS) and fixed it before pushing.
- [x] Fixed decimal-qty save bug, a form-reset bug, and added a real install banner (per commit `9176ea0` — landed between sessions, confirmed present via git log, not independently re-verified beyond that).

## How this file will be maintained

Every future change (schema migration, edge function, frontend edit, doc update) gets an entry added here in the same turn it's made — moved from "Open" to "Completed" once verified (not just written), with a one-line note on how it was verified (tool output, direct fetch, etc.). If a task is uncertain, it stays unchecked with a note on what's blocking it — nothing gets checked off on assumption.
