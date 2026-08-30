# Dogo POS — Documentation

A multi-business point-of-sale web app with camera + photo barcode scanning, OCR label matching, cloud sync, role-based Admin/Teller accounts, offline sales, shift/till reconciliation, atomic sale processing (no oversell races), M-Pesa payments, KRA eTIMS groundwork, business-type-specific tools (e.g. Hotel/Restaurant menus & tables), and a platform-admin business switcher for support/testing.

**Live app:** https://allen-otty.github.io/mini-pos/
**Backend:** Supabase project `mini-pos-backend` (id: `uzwomzkzqrpiumtnniik`)
**Source code:** https://github.com/Allen-Otty/mini-pos

---

## 1. What this is

Dogo POS is a Progressive Web App (PWA) — it runs entirely in a phone or computer browser, can be "installed" to a home screen like a native app, and works offline. It is **multi-tenant**: any number of separate businesses can sign up, and each business's data (products, sales, customers, expenses, staff) is completely isolated from every other business on the platform, enforced at the database level via Row Level Security.

### Core roles

| Role | Can do |
|---|---|
| **Admin** | Everything: manage catalog, view Dashboard/Reports, manage Team (create tellers), manage Customers, view & log Expenses, change Settings, sell items, manage Menu & Tables (Hotel/Restaurant), open/close shifts |
| **Teller** | Sell items (Sell tab), view/add Customers, log expenses (e.g. petty cash) but **cannot** view expense totals/history, **cannot** see Dashboard, Reports, Catalog, Team, or Settings; can open/close their own shift |

### Business types
Retail, Wholesale, Supermarket, SME, Hotel/Restaurant, Hardware Store, **Kiosk/Kibanda**. Choosing **Hotel/Restaurant** unlocks a dedicated **Menu & Tables** tab (see Section 5).

### Brand palette
Default UI colors: `#223068` (brand navy), `#1e4ba3` (blue actions), `#306c5f` (green/confirm actions), `#a5333f` (red/destructive actions), `#6000d3` (active tab accent). Each business can still pick its own header theme color independently in Settings.

---

## 2. How VAT works in this app

**Prices you enter are the final, VAT-inclusive selling price** — exactly what the customer pays. VAT is **extracted backward** from that price for KRA record-keeping, never added on top at checkout.

```
VAT amount = price − (price ÷ (1 + VAT rate))
```

Example: an item priced at **KES 116** with **16% VAT** → VAT = KES 16.00, excl-VAT amount = KES 100.00. Customer still pays exactly KES 116.

Every product also has a **unit** (Piece / kg / g / Litre), carried through the cart, checkout, and printed receipt.

---

## 3. Signing up (Admin / new business)

1. Open the app link → **"Create Business"**
2. Fill in: Business Name, Business Type, Your Full Name, Email, Password
3. Check your email for a **6-digit code** and type it into the app's Verify screen (do **not** click a link if one is ever present — the app needs the code entered so it can finish creating your business record; see Section 8 for why this matters)
4. Once verified, your business and Admin account are created and you're logged in

## 4. Adding Teller accounts

Admin → **Team** tab → enter name, email, password → **Create Teller Account**. Tellers log in through the normal Sign In tab.

---

## 5. Daily use

### Selling (Admin or Teller)
1. **Sell** tab → point the camera at a barcode, type a code manually, pick from the dropdown, or tap **📷 Scan Item Photo** to snap a photo instead — it first tries to decode a barcode from the photo, and if none is found, runs OCR (Tesseract.js) to read the label and match it against your catalog by name
2. If the code isn't in the catalog, Admin is prompted to add it on the spot (with unit, price, VAT, stock)
3. Adjust quantities with +/− in the cart
4. Checkout by **Cash** or **📱 M-Pesa** (STK Push — customer gets a PIN prompt, sale completes automatically once paid). Every sale — items, stock deduction, and the sale record — is written as one atomic database transaction (`process_sale` RPC), so two devices selling the last unit of the same item at once can't both succeed; the second is correctly rejected instead of silently overselling.
5. Printable receipt shows unit, M-Pesa receipt number (if applicable), and totals

### Shifts (cash reconciliation)
Every user (Admin or Teller) can **Open Shift** with an opening cash float before selling. **Close Shift** calculates expected cash (float + cash-only sales made during the shift — M-Pesa sales excluded since that money never sits in the drawer), prompts for the actual counted cash, and logs the variance. Admins see all closed shifts with variance flagged on the Dashboard.

### Menu & Tables (Hotel/Restaurant business type only)
A dedicated tab shows your Catalog items grouped by category as a menu, plus simple table management — add tables, tap to toggle Free/Occupied, remove tables.

### Offline selling
No internet → orange banner, checkout still works, sale queues locally and syncs automatically once back online (or tap the sync banner to force it). **Limitation:** only Sales queue offline — Customers/Expenses added offline are not queued.

### Restocking & low stock
Catalog tab (Admin) → Restock an item. Items at/below Reorder Level trigger a red banner app-wide for Admins and appear on the Dashboard.

### Dashboard (Admin only)
Today/month sales, KRA VAT estimate, low stock, **Team Performance** (per-teller sales count & revenue this month), and **Recent Shifts** (cash reconciliation history).

### Reports (Admin only)
Top-selling items — sorted by **quantity sold**, not revenue. Revenue by category.

---

## 6. Payments

### M-Pesa
Multi-tenant: each business enters its **own** Safaricom Daraja credentials in Settings (Till/Pochi la Biashara or Paybill, Shortcode, Consumer Key/Secret, Passkey, Sandbox/Production toggle). Credentials are write-only from the browser's perspective — stored in a locked-down table only the payment edge functions can read, never re-displayed after saving. Backed by three edge functions: `mpesa-settings` (save/status/remove), `mpesa-stkpush` (initiate), `mpesa-callback` (Safaricom's public webhook after payment/cancel).

### KRA eTIMS (structural groundwork — not yet live)
Settings → **KRA eTIMS** section: enter your KRA PIN/TIN and Branch ID. Every sale automatically builds the exact KRA-compliant OSCU/VSCU JSON payload (tax code breakdown A/B/C/E, item list, totals) and stores it in `etims_submissions`, ready for real submission the moment you have live OSCU/VSCU device credentials — swapping in the actual KRA HTTP call at that point is a small, contained change. Same secure credential-storage pattern as M-Pesa.

---

## 7. Platform Admin — business switcher

Allen's account (`platform_admins` table, `is_primary_owner`) can **switch its live view/test context to any business on the platform** from Settings → 🛠️ Platform Admin card. While switched, every tab — Sell, Catalog, Dashboard, Settings, M-Pesa, eTIMS — operates against that business's real data, for testing and support. This works by overriding the database's `current_business_id()` helper (which every Row Level Security policy calls) for platform admins only; regular business accounts are completely unaffected and cannot do this. Tap **Return to My Own Business** to switch back. The switch persists across page reloads until cleared.

---

## 8. Data model (for reference)

All tables live in Supabase Postgres under Row Level Security — every query is scoped to `business_id` via `current_business_id()`.

| Table | Purpose |
|---|---|
| `businesses` | One row per registered business |
| `profiles` | One row per user account, `role` = admin/teller |
| `products` | Catalog — VAT-inclusive price, `unit` (piece/kg/g/litre) |
| `customers` | Per-business customer list |
| `sales` / `sale_items` | Sale headers/lines — includes `payment_method`, `mpesa_receipt_no`, `shift_id`, `unit`, `tax_code`, eTIMS fields |
| `expenses` | Business costs — Admin only |
| `tables` | Hotel/Restaurant table management (free/occupied) |
| `shift_sessions` | Till open/close, opening float, expected/actual cash, variance |
| `mpesa_settings` / `mpesa_settings_status` | Per-business M-Pesa credentials (locked table + safe status view) |
| `etims_settings` / `etims_settings_status` | Per-business KRA credentials (same locked pattern) |
| `etims_submissions` | Built KRA fiscalization payloads per sale |
| `platform_admins` / `platform_active_business` | Platform-owner list and their active business-switch state |
| `low_stock_items` | View: products at/below reorder level |

**Database Functions:**
- `process_sale(...)` — SECURITY DEFINER RPC that writes a sale header, its line items, and decrements product stock as one atomic transaction, row-locking each product (`FOR UPDATE`) so two devices selling the last unit at once can't both succeed. Both cash and M-Pesa checkout call this instead of separate inserts.
- `current_business_id()` — the single source of truth every RLS policy calls to scope a query to the caller's business; transparently honors the platform-admin business switch override when active

**Edge Functions** (server-side only, service-role — never exposed to the browser):
- `create-business` — after OTP verification, creates business + admin profile atomically
- `create-teller` — Admin-gated teller account creation
- `mpesa-settings`, `mpesa-stkpush`, `mpesa-callback` — M-Pesa payment flow
- `etims-settings`, `etims-submit` — KRA eTIMS credential storage + payload builder
- `platform-switch-business` — platform-admin business switcher (list/switch/clear)

---

## 9. Hosting & deployment

- **Live link:** GitHub Pages — `https://allen-otty.github.io/mini-pos/` — every push to `main` auto-rebuilds within 1–2 minutes
- **Netlify** site (`dogo-pos`) created but not yet deployed — first deploy needs the CLI run from a real computer

```bash
git clone https://github.com/Allen-Otty/mini-pos.git
# edit index.html
git add -A
git commit -m "describe the change"
git push origin main
```

---

## 10. Known limitations & next steps

| Item | Status | What's needed |
|---|---|---|
| Phone/SMS OTP | Not active | Connect a paid SMS provider (Africa's Talking/Twilio) |
| eTIMS live submission | Structural only | Real KRA OSCU/VSCU device credentials (`etims_settings.cmc_key`) |
| Netlify hosting | Created, not deployed | Run the Netlify CLI deploy from a computer |
| Offline sync scope | Sales only | Customers/Expenses added offline are not queued |
| Multi-currency | Not supported | KES-only by design |
| Custom domain | Not set up | — |
| Product variants/batches, Daftari credit ledger | Not started | Part of the v4 blueprint, not yet built |
| `process_sale` atomic RPC | Not started | Planned once more v4 schema (variants/batches) exists |

---

## 11. Security notes

- The browser only ever holds a "publishable" Supabase key — RLS enforces everything else
- Service-role keys (which bypass RLS) are **only** used inside Edge Functions, server-side
- Every table has RLS enabled — a Teller cannot query another business's data even by tampering with requests
- M-Pesa and eTIMS credentials are stored in tables that block **all** direct reads (`using (false)`) — only their dedicated edge functions, running with service-role, can touch them; the browser never sees a saved secret again after entry
- The Platform Admin business switcher is scoped to accounts explicitly listed in `platform_admins` only — it cannot be triggered by any regular business account
- Every piece of user-typed free text (product/customer/teller/table names, categories, descriptions, business name, logo URL) is HTML-escaped (`escapeHtml()`) before being rendered anywhere in the app — prevents a malicious product/customer name from injecting a script that runs for other users viewing the Catalog, Cart, Receipt, or Dashboard
- Sales are written as a single atomic, row-locked database transaction (see `process_sale` above) — no partial writes, no oversell race between simultaneous devices
