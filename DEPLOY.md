# Dogo POS — Production Deployment Guide

Follow this top to bottom. Every step is either a click in a dashboard or a value to paste.

---

## 1. Deploy the Express payment server (Render — free tier to start)

1. Push `main` to GitHub (already done — the repo now includes `render.yaml`).
2. Go to https://dashboard.render.com → **New +** → **Blueprint** → connect `Allen-Otty/mini-pos`.
3. Render reads `render.yaml` and creates the `dogo-pos-api` service.
4. Fill in the env vars it marks `sync:false` (see the table in `.env.example`).
5. Deploy. On boot, the **startup check** prints a verdict in the logs: every gateway shows `PRODUCTION — ready`, `sandbox`, or exactly which variables are missing. Fix anything it flags.
6. Note your public URL, e.g. `https://dogo-pos-api.onrender.com` — this is `APP_URL`.

**Free-tier caveat:** Render free services sleep after ~15 min idle; the first payment after a sleep takes ~30s to wake. Upgrade to a paid plan (or set an uptime pinger) for live tills.

## 2. Point the POS app at your server

On each till device, once: open the POS → browser console →
`localStorage.setItem('dogo_api_url', 'https://dogo-pos-api.onrender.com')` → reload.
(Every `/api/payments` call then goes to your server, with the Supabase session attached automatically.)

## 3. Register payment-provider webhooks

| Provider | Where | URL to register |
|---|---|---|
| M-Pesa Daraja | developer.safaricom.co.ke → your app → APIs | `https://<APP_URL>/api/payments/callbacks/mpesa` |
| Paystack | dashboard.paystack.com → Settings → API Keys & Webhooks | `https://<APP_URL>/api/payments/callbacks/paystack` |
| KCB Buni | Buni developer portal | `https://<APP_URL>/api/payments/callbacks/kcb` (must send `x-kcb-signature` + timestamp) |
| Airtel | refused in production until a real integration exists | — |

## 4. Go live per gateway (flip only when the provider approves you)

1. Set the provider's live credentials (e.g. `sk_live_...`, Daraja production keys).
2. Set `MPESA_ENVIRONMENT=production` / `PAYSTACK_ENVIRONMENT=production`.
3. Restart the service; confirm the startup check says `PRODUCTION — ready`.
4. **Smoke test:** one real KES 1–10 payment end-to-end; confirm the receipt lands in Gateway Transactions and is business-scoped.

## 5. Supabase database (one-time, blocks plan assignment until run)

In Supabase → SQL Editor, run `supabase/migrations/20260930_subscription_enforcement.sql`
(or at minimum the four `alter table ... add column` statements for `subscription_plan`, `subscription_status`, `subscription_started_at`, `subscription_renews_at`).

## 6. Telegram bot (optional but recommended)

1. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID` (message `/start` to your bot to see your chat ID).
2. Restart. The bot now **refuses all data commands from any other chat** and `/health` reports only measured facts.

## 7. Final production checklist

- [ ] `NODE_ENV=production` (simulator endpoint returns 404)
- [ ] `DEMO_MODE` unset (no fake ledger rows)
- [ ] Startup check shows every intended gateway ready
- [ ] Admin console → Threat Scan → Run Full Scan → no critical findings
- [ ] `payment-complete.html` loads on the server host (Paystack return path)
- [ ] GitHub token revoked (if it was ever exposed)
- [ ] Supabase: review the `platform-admin` edge function (not in this repo)
