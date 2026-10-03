# Taking real payments with Dogo POS

Status of each gateway after the `real-money-gateways` work. **Nothing here has been run against a live
provider yet** - it was tested with mocked provider responses only. Test every gateway in the provider's
own test environment, with KES 1-10, before you point it at real customers.

| Gateway | What the POS does | Who confirms a payment | You must get from the provider |
|---|---|---|---|
| **M-Pesa** (Safaricom Daraja) | STK push to the customer's phone | Safaricom's STK status query (callback alone is never trusted) | Daraja app: consumer key + secret, passkey, shortcode / till |
| **Paystack** | Hosted checkout page (cards + M-Pesa) | Paystack's Verify API | Paystack Kenya account, `sk_test_` then `sk_live_` key |
| **KCB Buni** | M-PESA Express (STK push) through a KCB paybill | Secret per-payment callback URL + matching our own pending request (KCB gives no query we rely on) | Buni app key/secret, subscription to *Mpesa Express*, KCB go-live approval |
| **Airtel Money** | USSD push to the customer's phone | Airtel's transaction-enquiry API | Airtel developer app: client id + secret, Collections API enabled |

A gateway with **no credentials** runs in *simulated* mode: nothing is sent to any provider, the till shows
"DEMO MODE", and the Settings badge reads "NOT CONNECTED (DEMO)". A gateway set to **production** with no
credentials refuses to start a payment instead of faking one.

## 1. Host the payments server

The static site (GitHub Pages / Netlify) cannot receive provider callbacks. Run `node server.js` on a host with:

- a public **https://** address (this becomes `PUBLIC_BASE_URL`),
- a **persistent disk** for `PAYMENTS_DB_PATH` (pending payments are saved there; without it a restart loses them),
- **one instance only** (the payment file and rate limiter are per-process).

Then tell the web app where it is: set `window.DOGO_CONFIG = { api_url: 'https://pay.yourdomain.com' }`
(or `localStorage.dogo_api_url`). Copy `.env.example` to `.env` on the server and fill it in.
M-Pesa also still works through the existing Supabase `mpesa-stk-push` edge function on static hosting;
KCB, Airtel and Paystack need this server.

## 2. Per-provider setup

- **M-Pesa**: Daraja portal -> create app -> Lipa na M-Pesa Online. Use sandbox first (`is_production` off).
  For Buy Goods set `MPESA_TILL_NUMBER`. Production needs Safaricom go-live approval for your shortcode.
- **Paystack**: dashboard -> Settings -> API keys. In *Settings -> API Keys & Webhooks* set the webhook URL to
  `https://pay.yourdomain.com/api/payments/callbacks/paystack`. Live keys need business verification.
- **KCB Buni**: register on the Buni portal, create an app, subscribe it to *Mpesa Express*, get UAT keys.
  **Verify the token URL, base URL and request fields against your portal's Postman collection** - this code
  follows the published shape but KCB provisions each merchant individually. Production needs a signed
  request letter emailed to KCB.
- **Airtel**: developers portal -> create app -> enable Collections. Confirm whether your market uses the plain
  `/merchant/v1/payments/` endpoint (used here) or the encrypted v2 one.

## 3. How callbacks are protected

Safaricom and KCB do not sign callbacks, so each payment gets its own secret URL
(`/api/payments/callbacks/<gateway>/<token>`); anything else is rejected. Success is only accepted if it
matches a pending payment we created, and the amount recorded is **our** amount, never the callback's.
Paystack callbacks are HMAC-SHA512 signed and then re-checked with Paystack. Airtel and M-Pesa callbacks only
trigger a check with the provider; the provider's answer decides.

## 4. Go-live checklist

1. Each gateway tested in the provider's sandbox: success, customer cancels, wrong PIN, timeout.
2. A real KES 1-10 payment on each gateway in production, then confirm it appears in the provider dashboard,
   the POS receipt, and `data/payments.json`.
3. Switch the gateway to Production in Settings only after step 2 works.
4. Restart the server mid-payment once and confirm the payment still completes.
5. Keep the server logs (callbacks are logged) and reconcile against provider statements daily.

## 5. Known limits - read before trusting it with money

- **Not yet tested against real provider servers.** Expect to adjust field names on first contact.
- **No automatic reconciliation or refunds.** If a customer pays and the POS was offline, you must match the
  provider statement by hand (the receipt reference is stored on the payment record).
- KCB has no confirmation query in this code; its protection is the secret callback URL. A leaked URL for a
  pending payment could be abused until that payment completes or expires (5 minutes).
- Payments are stored in a local JSON file, not a database. Back it up; do not run two servers.
- The in-process rate limiter resets on restart.
