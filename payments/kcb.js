import crypto from 'crypto';
import {
  createPaymentRequest,
  getPaymentRequest,
  updatePaymentRequest,
  findRequestByCheckoutId,
  callbackTokenValid,
  getInternalConfig
} from './store.js';
import { callbackUrlFor, fetchJson, cachedToken, toE164Kenya } from './provider.js';

/**
 * KCB Buni "M-PESA Express" (STK push to a KCB paybill / shared short code).
 *
 * NOTE: written from KCB Buni's published API shape as documented by the Buni developer portal and
 * community integrations. KCB onboards each merchant individually, so confirm the token URL, the
 * base URL and the field names against YOUR Buni portal / Postman collection in the UAT environment
 * before enabling production (see PAYMENTS.md).
 *
 * KCB's STK callback is NOT signed. Protection is therefore: (1) a secret per-payment token in the
 * callback URL, (2) the CheckoutRequestID must match a pending request we created, (3) the amount
 * we credit is OUR amount, never the callback's.
 */
export function kcbIsLive() {
  const c = getInternalConfig('kcb');
  return !!(c && c.app_key && c.app_secret);
}

async function kcbAccessToken(config) {
  return cachedToken(`kcb:${config.token_url}:${config.app_key}`, async () => {
    const auth = Buffer.from(`${config.app_key}:${config.app_secret}`).toString('base64');
    const r = await fetchJson(config.token_url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!r.data || !r.data.access_token) throw new Error('KCB Buni rejected the consumer key/secret.');
    return { token: r.data.access_token, ttlSeconds: Number(r.data.expires_in) || 3600 };
  });
}

export async function initiateKcbPayment({ phone, account, amount, customerId, cart, metadata = {} }) {
  const config = getInternalConfig('kcb');
  const live = kcbIsLive();
  if (!live && config.is_production) {
    throw new Error('KCB is set to production but KCB_APP_KEY / KCB_APP_SECRET are not configured.');
  }

  const numericAmount = Math.max(1, Math.round(Number(amount))); // M-PESA takes whole shillings
  if (!phone && !account) {
    throw new Error('Please provide the customer\'s Safaricom phone number for the M-PESA prompt.');
  }
  const cleanAccount = account ? String(account).trim() : '';

  const request = createPaymentRequest({
    gateway: 'kcb',
    amount: numericAmount,
    phone: phone ? String(phone).replace(/\D/g, '') : '',
    account: cleanAccount,
    customerId,
    cart,
    metadata: { ...metadata, merchant_code: config.merchant_code, account_number: config.account_number, channel: 'KCB_MPESA_EXPRESS' }
  });

  if (!live) {
    const kcbRef = `KCB-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
    updatePaymentRequest(request.id, {
      simulated: true, checkout_request_id: kcbRef,
      merchant_request_id: `KCB-REQ-${request.id.slice(0, 8).toUpperCase()}`,
      result_desc: 'SIMULATED KCB prompt (no Buni credentials configured).'
    });
    return {
      success: true, simulated: true, payment_request_id: request.id, checkout_request_id: kcbRef,
      merchant_code: config.merchant_code, phone: request.phone, account: cleanAccount, amount: numericAmount, gateway: 'kcb',
      message: `SIMULATED KCB prompt for KES ${numericAmount.toFixed(2)} - no real money moves.`
    };
  }

  const msisdn = toE164Kenya(phone);
  if (!msisdn) {
    updatePaymentRequest(request.id, { status: 'failed', result_desc: 'Invalid customer phone number.' });
    throw new Error('Enter a valid Safaricom number (e.g. 0712345678) - KCB sends an M-PESA prompt to it.');
  }

  try {
    const callbackUrl = callbackUrlFor('kcb', request, { production: config.is_production });
    const token = await kcbAccessToken(config);
    const r = await fetchJson(`${config.base_url}/mm/api/request/1.0.0/stkpush`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phoneNumber: msisdn,
        amount: String(numericAmount),
        invoiceNumber: config.account_number,
        sharedShortCode: config.shared_short_code,
        orgShortCode: config.org_short_code,
        orgPassKey: config.org_pass_key,
        callbackUrl,
        transactionDescription: `POS ${request.id.slice(0, 8)}`.slice(0, 13)
      })
    });
    const resp = (r.data && r.data.response) || {};
    const header = (r.data && r.data.header) || {};
    if (!resp.CheckoutRequestID || String(resp.ResponseCode ?? header.statusCode) !== '0') {
      throw new Error(resp.ResponseDescription || header.statusDescription || `KCB did not accept the request (HTTP ${r.status}).`);
    }
    updatePaymentRequest(request.id, {
      phone: msisdn,
      checkout_request_id: resp.CheckoutRequestID,
      merchant_request_id: resp.MerchantRequestID || request.merchant_request_id,
      result_desc: resp.CustomerMessage || 'KCB M-PESA prompt sent. Waiting for the customer\'s PIN.'
    });
  } catch (err) {
    updatePaymentRequest(request.id, { status: 'failed', result_desc: `KCB request failed: ${err.message}` });
    throw new Error(`KCB request failed: ${err.message}`);
  }

  return {
    success: true,
    payment_request_id: request.id,
    checkout_request_id: getPaymentRequest(request.id).checkout_request_id,
    merchant_code: config.merchant_code,
    phone: msisdn,
    account: cleanAccount,
    amount: numericAmount,
    gateway: 'kcb',
    message: `KCB M-PESA prompt sent to ${msisdn} for KES ${numericAmount.toFixed(2)}. Ask the customer to enter their PIN.`
  };
}

/**
 * Processes a KCB STK callback (Daraja-style Body.stkCallback).
 * `token` is the secret from the callback URL path. Simulated requests are exempt (no real money).
 */
export function processKcbCallback(payload, token) {
  const callback = payload && payload.Body && payload.Body.stkCallback;
  if (!callback) {
    return { verified: false, statusCode: 400, response: { ResultCode: 1, ResultDesc: 'Malformed callback' } };
  }

  const request = findRequestByCheckoutId(callback.CheckoutRequestID) || findRequestByCheckoutId(callback.MerchantRequestID);
  if (!request || request.gateway !== 'kcb') {
    console.warn(`[KCB Callback] No matching request for ${callback.CheckoutRequestID}`);
    return { verified: false, statusCode: 200, response: { ResultCode: 0, ResultDesc: 'Received' } };
  }

  if (!request.simulated && !callbackTokenValid(request, token)) {
    console.warn(`[KCB Callback] Bad or missing callback token for ${request.id} - rejected`);
    return { verified: false, statusCode: 401, response: { ResultCode: 1, ResultDesc: 'Unauthorized' } };
  }

  // Idempotency: KCB retries callbacks. A settled payment is never changed again.
  if (request.status === 'success') {
    return { verified: true, statusCode: 200, response: { ResultCode: 0, ResultDesc: 'Already processed' } };
  }
  if (request.status === 'failed' || request.status === 'cancelled') {
    return { verified: false, statusCode: 200, response: { ResultCode: 0, ResultDesc: 'Already processed' } };
  }

  const resultCode = Number(callback.ResultCode);
  if (resultCode !== 0) {
    const status = resultCode === 1032 ? 'cancelled' : 'failed';
    updatePaymentRequest(request.id, {
      status, result_desc: callback.ResultDesc || `KCB/M-PESA payment failed (code ${resultCode})`, raw_callback: payload
    });
    return { verified: true, statusCode: 200, paymentRequestId: request.id, status, response: { ResultCode: 0, ResultDesc: 'Accepted' } };
  }

  const items = (callback.CallbackMetadata && callback.CallbackMetadata.Item) || [];
  const meta = {};
  for (const it of items) if (it.Name) meta[it.Name] = it.Value;

  // Never credit more than we asked for, never accept less.
  const reported = Number(meta.Amount);
  if (Number.isFinite(reported) && reported < request.amount) {
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: `KCB underpayment: received KES ${reported}, expected KES ${request.amount}`,
      raw_callback: payload
    });
    return { verified: false, statusCode: 200, response: { ResultCode: 0, ResultDesc: 'Amount mismatch' } };
  }

  const receipt = meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : `KCB${Date.now().toString(36).toUpperCase()}`;
  updatePaymentRequest(request.id, {
    status: 'success',
    receipt_reference: receipt,
    amount_paid: request.amount,
    phone: meta.PhoneNumber ? String(meta.PhoneNumber) : request.phone,
    result_desc: 'KCB M-PESA payment confirmed.',
    raw_callback: payload
  });
  return {
    verified: true, statusCode: 200, paymentRequestId: request.id,
    receipt, amount: request.amount, status: 'success',
    response: { ResultCode: 0, ResultDesc: 'Callback processed successfully' }
  };
}

/** Kept for the sandbox simulator: builds the same Daraja-style payload KCB sends. */
export function buildSimulatedKcbCallback(request, { success = true, receipt } = {}) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: request.merchant_request_id,
        CheckoutRequestID: request.checkout_request_id,
        ResultCode: success ? 0 : 1032,
        ResultDesc: success ? 'The service request is processed successfully.' : 'Request cancelled by user',
        CallbackMetadata: success ? {
          Item: [
            { Name: 'Amount', Value: request.amount },
            { Name: 'MpesaReceiptNumber', Value: receipt || `KCB${Math.floor(100000 + Math.random() * 900000)}` },
            { Name: 'PhoneNumber', Value: request.phone || '254712345678' }
          ]
        } : null
      }
    }
  };
}

/** HMAC helper retained for backwards compatibility with older tooling. */
export function generateKcbSignature(dataString, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(dataString).digest('hex');
}
