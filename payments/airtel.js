import crypto from 'crypto';
import {
  createPaymentRequest,
  getPaymentRequest,
  updatePaymentRequest,
  findRequestByGatewayRef,
  findRequestByCheckoutId,
  getInternalConfig
} from './store.js';
import { fetchJson, cachedToken, toE164Kenya } from './provider.js';

/**
 * Airtel Money Open API - Collections (USSD push), v1 (plain JSON) endpoints.
 *
 * NOTE: written from Airtel Africa's published Open API shape. Airtel provisions each merchant
 * separately and some markets use the encrypted "v2" payments endpoint; confirm against YOUR
 * Airtel developer portal in the UAT environment before going live (see PAYMENTS.md).
 *
 * Airtel's callback is not trusted on its own: every callback only triggers a call to Airtel's
 * transaction-enquiry API, and that answer decides whether a payment is marked paid.
 */
export function airtelIsLive() {
  const c = getInternalConfig('airtel');
  return !!(c && c.client_id && c.client_secret);
}

async function airtelToken(config) {
  return cachedToken(`airtel:${config.base_url}:${config.client_id}`, async () => {
    const r = await fetchJson(`${config.base_url}/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({ client_id: config.client_id, client_secret: config.client_secret, grant_type: 'client_credentials' })
    });
    if (!r.data || !r.data.access_token) throw new Error('Airtel rejected the client id/secret.');
    return { token: r.data.access_token, ttlSeconds: Number(r.data.expires_in) || 3600 };
  });
}

function airtelHeaders(config, token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'X-Country': config.country,
    'X-Currency': config.currency
  };
}

export async function initiateAirtelPayment({ phone, amount, customerId, cart, metadata = {} }) {
  const config = getInternalConfig('airtel');
  const live = airtelIsLive();
  if (!live && config.is_production) {
    throw new Error('Airtel is set to production but AIRTEL_CLIENT_ID / AIRTEL_CLIENT_SECRET are not configured.');
  }
  if (!phone) throw new Error('Please provide a customer phone number for Airtel Money.');

  const numericAmount = Math.max(1, Math.round(Number(amount)));
  const msisdn = toE164Kenya(phone);

  const request = createPaymentRequest({
    gateway: 'airtel',
    amount: numericAmount,
    phone: msisdn || String(phone).replace(/\D/g, ''),
    customerId,
    cart,
    metadata: { ...metadata, merchant_number: config.merchant_number }
  });

  const txnId = `DOGO${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

  if (!live) {
    updatePaymentRequest(request.id, {
      simulated: true, checkout_request_id: txnId,
      merchant_request_id: `AIR-REQ-${request.id.slice(0, 8).toUpperCase()}`,
      result_desc: 'SIMULATED Airtel prompt (no Airtel credentials configured).'
    });
    return {
      success: true, simulated: true, payment_request_id: request.id, checkout_request_id: txnId,
      phone: request.phone, amount: numericAmount, gateway: 'airtel',
      message: `SIMULATED Airtel prompt for KES ${numericAmount.toFixed(2)} - no real money moves.`
    };
  }

  if (!msisdn) {
    updatePaymentRequest(request.id, { status: 'failed', result_desc: 'Invalid customer phone number.' });
    throw new Error('Enter a valid Airtel number (e.g. 0733123456).');
  }

  try {
    const token = await airtelToken(config);
    const r = await fetchJson(`${config.base_url}/merchant/v1/payments/`, {
      method: 'POST',
      headers: airtelHeaders(config, token),
      body: JSON.stringify({
        reference: `POS ${request.id.slice(0, 8)}`,
        subscriber: { country: config.country, currency: config.currency, msisdn: msisdn.replace(/^254/, '') },
        transaction: { amount: numericAmount, country: config.country, currency: config.currency, id: txnId }
      })
    });
    const d = r.data || {};
    const accepted = (d.status && d.status.success === true) || String(d.status?.code) === '200';
    if (!accepted) {
      throw new Error((d.status && d.status.message) || `Airtel did not accept the request (HTTP ${r.status}).`);
    }
    updatePaymentRequest(request.id, {
      phone: msisdn,
      checkout_request_id: txnId,   // Airtel echoes the id WE sent; we always enquire by it
      merchant_request_id: txnId,
      result_desc: 'Airtel Money prompt sent. Waiting for the customer\'s PIN.'
    });
  } catch (err) {
    updatePaymentRequest(request.id, { status: 'failed', result_desc: `Airtel request failed: ${err.message}` });
    throw new Error(`Airtel request failed: ${err.message}`);
  }

  return {
    success: true,
    payment_request_id: request.id,
    checkout_request_id: getPaymentRequest(request.id).checkout_request_id,
    phone: msisdn,
    amount: numericAmount,
    gateway: 'airtel',
    message: `Airtel Money prompt sent to ${msisdn} for KES ${numericAmount.toFixed(2)}. Ask the customer to enter their PIN.`
  };
}

/**
 * Asks Airtel's transaction-enquiry API for the real status of a payment.
 * TS = success; TF/TE = failed/expired; TIP/TA = still in progress / ambiguous (stay pending).
 */
export async function confirmAirtelRequest(requestId) {
  const request = getPaymentRequest(requestId);
  if (!request) return null;
  if (!airtelIsLive() || request.simulated) return request;
  if (['success', 'failed', 'cancelled'].includes(request.status)) return request;

  const config = getInternalConfig('airtel');
  try {
    const token = await airtelToken(config);
    const r = await fetchJson(`${config.base_url}/standard/v1/payments/${encodeURIComponent(request.checkout_request_id)}`, {
      headers: airtelHeaders(config, token)
    });
    const t = r.data && r.data.data && r.data.data.transaction;
    if (!t) return getPaymentRequest(requestId);
    const status = String(t.status || '').toUpperCase();
    if (status === 'TS') {
      updatePaymentRequest(request.id, {
        status: 'success',
        receipt_reference: t.airtel_money_id || request.checkout_request_id,
        amount_paid: request.amount,
        result_desc: 'Airtel Money payment confirmed.'
      });
    } else if (status === 'TF' || status === 'TE') {
      updatePaymentRequest(request.id, { status: 'failed', result_desc: t.message || `Airtel payment ${status === 'TE' ? 'expired' : 'failed'}.` });
    }
  } catch (err) {
    console.warn('[Airtel enquiry] error:', err.message);
  }
  return getPaymentRequest(requestId);
}

/** Real webhook entry point: the callback only says "go and check"; Airtel's own answer decides. */
export async function confirmAndProcessAirtelCallback(payload, headers = {}) {
  if (!payload || typeof payload !== 'object') {
    return { verified: false, statusCode: 400, response: { status: 'FAILED', message: 'Invalid payload' } };
  }
  const t = payload.transaction || payload.data?.transaction || payload;
  const ref = t.id || t.reference_id || payload.reference_id || payload.checkout_request_id;
  const request = findRequestByCheckoutId(ref) || findRequestByGatewayRef('airtel', ref);
  if (!request) return { verified: false, statusCode: 200, response: { status: 'ACKNOWLEDGED' } };
  if (request.status === 'success') return { verified: true, statusCode: 200, response: { status: 'SUCCESS', message: 'Already processed' } };

  if (request.simulated || !airtelIsLive()) {
    return verifyAndProcessAirtelCallback(payload, headers);
  }
  const confirmed = await confirmAirtelRequest(request.id);
  const ok = confirmed && confirmed.status === 'success';
  return {
    verified: !!ok, statusCode: 200, paymentRequestId: request.id, status: confirmed ? confirmed.status : 'pending',
    response: { status: ok ? 'SUCCESS' : 'ACKNOWLEDGED' }
  };
}

/**
 * Payload-trusting processing. ONLY for simulated requests (sandbox demo, no real money);
 * a real Airtel payment can never be completed through this function.
 */
export function verifyAndProcessAirtelCallback(payload, headers = {}) {
  if (!payload || typeof payload !== 'object') {
    return { verified: false, statusCode: 400, response: { status: 'FAILED', message: 'Invalid payload' } };
  }

  const transaction = payload.transaction || payload.data?.transaction || payload;
  const ref = transaction.reference_id || transaction.id || payload.reference_id || payload.checkout_request_id;

  const request = findRequestByCheckoutId(ref) || findRequestByGatewayRef('airtel', ref);

  if (!request) {
    console.warn(`[Airtel Callback] No matching request found for reference: ${ref}`);
    return { verified: false, statusCode: 200, response: { status: 'ACKNOWLEDGED' } };
  }

  if (!request.simulated) {
    console.warn(`[Airtel Callback] Refusing to trust payload for a real payment (${request.id})`);
    return { verified: false, statusCode: 403, response: { status: 'FAILED', message: 'Real payments are confirmed with Airtel directly' } };
  }

  const status = String(transaction.status || transaction.status_code || payload.status || '').toUpperCase();
  const isSuccess = ['TS', 'SUCCESS', '200', 'APPROVED'].includes(status);

  if (!isSuccess) {
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: transaction.message || `Airtel Money transaction failed with status ${status}`,
      raw_callback: payload
    });
    return { verified: true, statusCode: 200, paymentRequestId: request.id, status: 'failed', response: { status: 'FAILED', message: 'Failure acknowledged' } };
  }

  const paidAmount = Number(transaction.amount) || request.amount;
  if (paidAmount < request.amount) {
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: `Airtel underpayment: received KES ${paidAmount}, expected KES ${request.amount}`,
      raw_callback: payload
    });
    return { verified: false, statusCode: 200, response: { status: 'AMOUNT_MISMATCH' } };
  }

  const airtelReceipt = transaction.airtel_money_id || `AIR${Date.now().toString(36).toUpperCase()}`;
  updatePaymentRequest(request.id, {
    status: 'success',
    receipt_reference: airtelReceipt,
    amount_paid: paidAmount,
    result_desc: 'Airtel Money payment confirmed successfully.',
    raw_callback: payload
  });
  return {
    verified: true, statusCode: 200, paymentRequestId: request.id, receipt: airtelReceipt,
    amount: paidAmount, status: 'success', response: { status: 'SUCCESS', message: 'Payment confirmed' }
  };
}
