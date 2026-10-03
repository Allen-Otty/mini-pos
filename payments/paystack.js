import crypto from 'crypto';
import {
  createPaymentRequest,
  getPaymentRequest,
  updatePaymentRequest,
  findRequestByGatewayRef,
  findRequestByCheckoutId,
  getInternalConfig
} from './store.js';

/**
 * Initiates a Paystack checkout or charge request
 */
export async function initiatePaystackPayment({ email, phone, amount, customerId, cart, metadata = {} }) {
  const config = getInternalConfig('paystack');
  const numericAmount = Math.max(1, Number(amount));
  const customerEmail = email && email.includes('@') ? email : `customer-${Date.now()}@dogopos.app`;

  const secretKey = config.secret_key;
  if (!secretKey) {
    throw new Error('Paystack is not configured. Save your Paystack Secret Key in Settings > Integrations first.');
  }

  const request = createPaymentRequest({
    gateway: 'paystack',
    amount: numericAmount,
    phone: phone || '',
    customerId,
    cart,
    metadata: {
      ...metadata,
      email: customerEmail,
      currency: 'KES'
    }
  });

  const callbackBase = process.env.APP_URL || 'http://localhost:3000';

  // Ask Paystack for a real hosted checkout page. Without this call no money moves.
  let authorizationUrl = null;
  let paystackRef = null;
  let accessCode = null;
  const apiBase = config.is_production ? 'https://api.paystack.co' : 'https://api.paystack.co'; // test and live share one API host; the key decides the mode
  try {
    const psResp = await fetch(`${apiBase}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: customerEmail,
        amount: Math.round(numericAmount * 100), // Paystack expects kobo (subunits)
        currency: 'KES',
        reference: request.checkout_request_id,
        callback_url: `${callbackBase}/payment-complete.html`,
        metadata: { ...request.metadata, phone: phone || '' }
      })
    });
    const psData = await psResp.json();
    if (psData.status && psData.data) {
      authorizationUrl = psData.data.authorization_url;
      accessCode = psData.data.access_code;
      paystackRef = psData.data.reference;
    } else {
      updatePaymentRequest(request.id, {
        status: 'failed',
        result_desc: `Paystack initialize failed: ${psData.message || 'unknown error'}`
      });
      throw new Error(`Paystack initialize failed: ${psData.message || 'unknown error'}`);
    }
  } catch (err) {
    if (err.message && err.message.startsWith('Paystack initialize failed')) throw err;
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: `Paystack unreachable: ${err.message}`
    });
    throw new Error(`Could not reach Paystack: ${err.message}`);
  }

  updatePaymentRequest(request.id, {
    checkout_request_id: paystackRef,
    merchant_request_id: paystackRef,
    result_desc: 'Paystack checkout page opened. Waiting for customer completion.'
  });

  return {
    success: true,
    payment_request_id: request.id,
    checkout_request_id: paystackRef,
    authorization_url: authorizationUrl,
    access_code: accessCode,
    amount: numericAmount,
    gateway: 'paystack',
    email: customerEmail,
    message: `Paystack checkout opened for KES ${numericAmount.toFixed(2)}.`
  };
}

/**
 * Re-checks a payment directly with Paystack (server-to-server). This is the
 * authoritative confirmation used by /status - the webhook is a convenience, not the source of truth.
 */
export async function verifyPaystackPayment(paymentRequestId) {
  const config = getInternalConfig('paystack');
  const secretKey = config.secret_key;
  const request = getPaymentRequest(paymentRequestId);
  if (!request || !request.checkout_request_id) return request || null;
  if (!secretKey) return request; // cannot verify without a key; leave status untouched

  try {
    const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(request.checkout_request_id)}`, {
      headers: { Authorization: `Bearer ${secretKey}` }
    });
    const data = await resp.json();
    if (data.status && data.data) {
      const tx = data.data;
      if (tx.status === 'success') {
        const paidAmount = Number(tx.amount) / 100;
        if (paidAmount + 0.01 < request.amount) {
          updatePaymentRequest(request.id, {
            status: 'failed',
            result_desc: `Paystack underpayment: paid KES ${paidAmount.toFixed(2)}, expected KES ${request.amount}`,
            raw_callback: tx
          });
        } else if (request.status === 'pending') {
          updatePaymentRequest(request.id, {
            status: 'success',
            receipt_reference: tx.reference,
            amount_paid: paidAmount,
            result_desc: `Paystack payment confirmed via ${tx.channel || 'card/mobile'}.`,
            raw_callback: tx
          });
        }
      } else if (['failed', 'abandoned', 'reversed'].includes(tx.status) && request.status === 'pending') {
        updatePaymentRequest(request.id, {
          status: tx.status === 'failed' ? 'failed' : 'pending', // abandoned stays pending (customer may still pay)
          result_desc: `Paystack reports ${tx.status}.`
        });
      }
    }
  } catch (err) {
    console.warn('[Paystack verify] network error:', err.message);
  }
  return getPaymentRequest(paymentRequestId);
}

/**
 * Verifies Paystack Webhook with HMAC-SHA512 against raw payload
 */
export function verifyAndProcessPaystackCallback(payload, rawBody, headers = {}) {
  const config = getInternalConfig('paystack');
  const signature = headers['x-paystack-signature'];
  const secretKey = config.secret_key; // resolved centrally in store.js — never falls back to a hardcoded value

  if (!payload || typeof payload !== 'object') {
    return { verified: false, statusCode: 400, response: { message: 'Invalid payload' } };
  }

  // 1. Signature Verification with HMAC-SHA512
  // Paystack always signs its webhooks, so the signature is required in every environment
  // (previously a request with no header was accepted outside production, and a header with no
  // raw body skipped the check entirely).
  if (!secretKey) {
    return { verified: false, statusCode: 503, response: { message: 'Webhook secret not configured' } };
  }
  if (!signature || !rawBody) {
    console.warn('[Paystack Webhook] Missing signature or raw body - rejected');
    return { verified: false, statusCode: 401, response: { message: 'Signature required' } };
  }
  {
    try {
      const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
      const signatureBuffer = Buffer.from(signature, 'hex');
      const hashBuffer = Buffer.from(hash, 'hex');

      if (signatureBuffer.length !== hashBuffer.length || !crypto.timingSafeEqual(signatureBuffer, hashBuffer)) {
        console.warn('[Paystack Webhook] Invalid HMAC-SHA512 signature');
        return { verified: false, statusCode: 401, response: { message: 'Invalid signature' } };
      }
    } catch (e) {
      console.warn('[Paystack Webhook] Signature verification error:', e.message);
      return { verified: false, statusCode: 401, response: { message: 'Invalid signature format' } };
    }
  }

  const event = payload.event;
  const data = payload.data || {};

  // Check event type
  if (event !== 'charge.success') {
    return { verified: true, statusCode: 200, response: { message: `Ignored event: ${event}` } };
  }

  const reference = data.reference;
  const request = findRequestByCheckoutId(reference) || findRequestByGatewayRef('paystack', reference);

  if (!request) {
    console.warn(`[Paystack Webhook] No matching transaction for ref: ${reference}`);
    return { verified: false, statusCode: 200, response: { message: 'Acknowledged' } };
  }

  // Amount verification: Paystack returns amounts in 100x (subunits/cents)
  const paidAmount = Number(data.amount) / 100 || request.amount;
  if (paidAmount < request.amount) {
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: `Paystack underpayment: received KES ${paidAmount}, expected KES ${request.amount}`,
      raw_callback: payload
    });
    return { verified: false, statusCode: 200, response: { message: 'Amount mismatch' } };
  }

  const receiptRef = data.reference || `PSTK-${data.id || Math.floor(100000 + Math.random() * 900000)}`;

  updatePaymentRequest(request.id, {
    status: 'success',
    receipt_reference: receiptRef,
    amount_paid: paidAmount,
    result_desc: `Paystack payment confirmed via ${data.channel || 'card/mobile'}.`,
    raw_callback: payload
  });

  return {
    verified: true,
    statusCode: 200,
    paymentRequestId: request.id,
    receipt: receiptRef,
    amount: paidAmount,
    status: 'success',
    response: { message: 'Webhook verified and processed' }
  };
}

/** A real Paystack key looks like sk_test_... or sk_live_... (the dev fallback is random hex). */
export function paystackIsLive() {
  const c = getInternalConfig('paystack');
  return !!(c && /^sk_(test|live)_/.test(c.secret_key || ''));
}

/**
 * Real webhook entry point: HMAC-SHA512 signature first (reusing the verifier below), then - for
 * a real Paystack payment - Paystack's own Verify API decides, never the webhook body.
 */
export async function confirmAndProcessPaystackCallback(payload, rawBody, headers = {}) {
  // Signature + matching is done by the existing verifier; we only add server-to-server confirmation.
  const preview = payload && payload.event === 'charge.success' ? (payload.data || {}).reference : null;
  const request = preview ? (findRequestByCheckoutId(preview) || findRequestByGatewayRef('paystack', preview)) : null;

  if (request && !request.simulated && paystackIsLive() && request.status === 'pending') {
    // Authenticate the webhook first, then ask Paystack.
    const secretKey = getInternalConfig('paystack').secret_key;
    const sig = headers['x-paystack-signature'];
    if (!secretKey) return { verified: false, statusCode: 503, response: { message: 'Webhook secret not configured' } };
    if (!sig || !rawBody) return { verified: false, statusCode: 401, response: { message: 'Signature required' } };
    try {
      const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
      const a = Buffer.from(sig, 'hex'), b = Buffer.from(hash, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { verified: false, statusCode: 401, response: { message: 'Invalid signature' } };
      }
    } catch { return { verified: false, statusCode: 401, response: { message: 'Invalid signature format' } }; }
    const confirmed = await verifyPaystackPayment(request.id);
    const ok = confirmed && confirmed.status === 'success';
    return {
      verified: !!ok, statusCode: 200, paymentRequestId: request.id, status: confirmed ? confirmed.status : 'pending',
      response: { message: ok ? 'Webhook verified and processed' : 'Not confirmed by Paystack' }
    };
  }
  return verifyAndProcessPaystackCallback(payload, rawBody, headers);
}
