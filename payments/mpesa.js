import crypto from 'crypto';
import {
  createPaymentRequest,
  getPaymentRequest,
  updatePaymentRequest,
  findRequestByCheckoutId,
  callbackTokenValid,
  getInternalConfig
} from './store.js';
import { callbackUrlFor, fetchJson, cachedToken } from './provider.js';

/**
 * Normalizes Kenyan telephone numbers to Safaricom Daraja format: 2547XXXXXXXX or 2541XXXXXXXX
 */
export function normalizeMpesaPhone(phoneStr) {
  if (!phoneStr) return null;
  let digits = String(phoneStr).replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = '254' + digits.slice(1);
  } else if (digits.startsWith('7') || digits.startsWith('1')) {
    digits = '254' + digits;
  } else if (digits.startsWith('2540')) {
    digits = '254' + digits.slice(4);
  }
  if (!/^254(7|1)\d{8}$/.test(digits)) {
    // Return original digits if already 12 digits, else best effort
    if (digits.length === 12 && digits.startsWith('254')) return digits;
  }
  return digits;
}

/**
 * Formats date to Daraja timestamp: YYYYMMDDHHmmss
 */
export function formatDarajaTimestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${m}${d}${h}${min}${s}`;
}

/**
 * Generates Daraja password base64(Shortcode + Passkey + Timestamp)
 */
export function generateDarajaPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

/**
 * Initiates an M-Pesa STK Push (Lipa na M-Pesa Online)
 */
export async function initiateMpesaStkPush({ phone, amount, customerId, cart, metadata = {} }) {
  const config = getInternalConfig('mpesa');
  const normalizedPhone = normalizeMpesaPhone(phone);

  if (!normalizedPhone || normalizedPhone.length < 10) {
    throw new Error('Please provide a valid Safaricom phone number (e.g. 0712345678).');
  }

  const live = hasLiveMpesaCredentials();
  if (!live && config.is_production) {
    throw new Error('M-Pesa is set to production but no Daraja consumer key/secret are configured.');
  }

  // Daraja only accepts whole shillings
  const numericAmount = Math.max(1, Math.round(Number(amount)));
  const shortcode = config.shortcode || '174379';
  const passkey = config.passkey || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  const timestamp = formatDarajaTimestamp();
  const password = generateDarajaPassword(shortcode, passkey, timestamp);
  const isTill = config.payment_type !== 'paybill';

  const request = createPaymentRequest({
    gateway: 'mpesa',
    amount: numericAmount,
    phone: normalizedPhone,
    customerId,
    cart,
    metadata: { ...metadata, payment_type: config.payment_type, shortcode, timestamp }
  });

  if (!live) {
    // No credentials and not production: clearly-labelled simulation for demos/testing only.
    updatePaymentRequest(request.id, { simulated: true, result_desc: 'SIMULATED M-Pesa prompt (no Daraja credentials configured).' });
    return {
      success: true, simulated: true,
      payment_request_id: request.id, checkout_request_id: request.checkout_request_id,
      phone: normalizedPhone, amount: numericAmount, gateway: 'mpesa',
      message: `SIMULATED STK push for ${normalizedPhone} - no real money moves. Use the webhook simulator to approve.`
    };
  }

  const base = config.is_production ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  let callbackUrl;
  try {
    callbackUrl = callbackUrlFor('mpesa', request, { production: config.is_production });
  } catch (e) {
    updatePaymentRequest(request.id, { status: 'failed', result_desc: e.message });
    throw e;
  }

  try {
    const tokenKey = `mpesa:${config.is_production ? 'prod' : 'sandbox'}:${config.consumer_key}`;
    const accessToken = await cachedToken(tokenKey, async () => {
      const auth = Buffer.from(`${config.consumer_key}:${config.consumer_secret}`).toString('base64');
      const r = await fetchJson(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
      if (!r.data || !r.data.access_token) throw new Error('Safaricom rejected the Daraja consumer key/secret.');
      return { token: r.data.access_token, ttlSeconds: Number(r.data.expires_in) || 3599 };
    });

    const stk = await fetchJson(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: isTill ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
        Amount: numericAmount,
        PartyA: normalizedPhone,
        PartyB: (isTill && config.till_number) ? config.till_number : shortcode,
        PhoneNumber: normalizedPhone,
        CallBackURL: callbackUrl,
        AccountReference: `POS${request.id.slice(0, 8)}`,
        TransactionDesc: `Dogo POS ${request.id.slice(0, 6)}`
      })
    });

    const d = stk.data || {};
    if (!d.CheckoutRequestID || String(d.ResponseCode) !== '0') {
      throw new Error(d.errorMessage || d.ResponseDescription || `Safaricom did not accept the STK push (HTTP ${stk.status}).`);
    }
    updatePaymentRequest(request.id, {
      checkout_request_id: d.CheckoutRequestID,
      merchant_request_id: d.MerchantRequestID || request.merchant_request_id,
      result_desc: d.CustomerMessage || 'STK Push sent to phone.'
    });
  } catch (err) {
    // Never tell a cashier "prompt sent" when nothing was sent.
    updatePaymentRequest(request.id, { status: 'failed', result_desc: `STK push failed: ${err.message}` });
    throw new Error(`M-Pesa STK push failed: ${err.message}`);
  }

  return {
    success: true,
    payment_request_id: request.id,
    checkout_request_id: getPaymentRequest(request.id).checkout_request_id,
    phone: normalizedPhone,
    amount: numericAmount,
    gateway: 'mpesa',
    message: `STK push sent to ${normalizedPhone} for KES ${numericAmount.toFixed(2)}. Ask the customer to enter their M-Pesa PIN.`
  };
}

/**
 * Handles and securely verifies Safaricom Daraja STK Push Callback
 */
export function verifyAndProcessMpesaCallback(payload, headers = {}) {
  if (!payload || !payload.Body || !payload.Body.stkCallback) {
    return {
      verified: false,
      statusCode: 400,
      response: { ResultCode: 1, ResultDesc: 'Malformed callback payload: missing Body.stkCallback' }
    };
  }

  const callback = payload.Body.stkCallback;
  const checkoutRequestId = callback.CheckoutRequestID;
  const merchantRequestId = callback.MerchantRequestID;
  const resultCode = Number(callback.ResultCode);
  const resultDesc = callback.ResultDesc || '';

  // Locate the internal payment request
  const request = findRequestByCheckoutId(checkoutRequestId) || findRequestByCheckoutId(merchantRequestId);

  if (!request) {
    console.warn(`[M-Pesa Callback] Payment request not found for CheckoutRequestID: ${checkoutRequestId}`);
    // Acknowledge to Safaricom to prevent retries
    return {
      verified: false,
      statusCode: 200,
      response: { ResultCode: 0, ResultDesc: 'Received but request not found in store' }
    };
  }

  // Handle Failure / User Cancellation
  if (resultCode !== 0) {
    let failureStatus = 'failed';
    if (resultCode === 1032) {
      failureStatus = 'cancelled';
    }

    updatePaymentRequest(request.id, {
      status: failureStatus,
      result_desc: resultDesc || `M-Pesa transaction failed with code ${resultCode}`,
      raw_callback: payload
    });

    return {
      verified: true,
      statusCode: 200,
      paymentRequestId: request.id,
      status: failureStatus,
      response: { ResultCode: 0, ResultDesc: 'Accepted cancellation' }
    };
  }

  // Handle Success: Extract CallbackMetadata Items
  const items = (callback.CallbackMetadata && callback.CallbackMetadata.Item) || [];
  const metadataMap = {};
  for (const it of items) {
    if (it.Name) {
      metadataMap[it.Name] = it.Value;
    }
  }

  const mpesaReceipt = metadataMap.MpesaReceiptNumber || `MP${Date.now().toString(36).toUpperCase()}`;
  const amountPaid = Number(metadataMap.Amount) || request.amount;
  const payingPhone = metadataMap.PhoneNumber ? String(metadataMap.PhoneNumber) : request.phone;
  const transDate = metadataMap.TransactionDate ? String(metadataMap.TransactionDate) : formatDarajaTimestamp();

  // Security Check: Verify amount matches to prevent underpayment exploits
  if (amountPaid < request.amount) {
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: `Tampering detected: Paid amount KES ${amountPaid} is less than required KES ${request.amount}`,
      raw_callback: payload
    });

    return {
      verified: false,
      statusCode: 200,
      paymentRequestId: request.id,
      status: 'failed',
      response: { ResultCode: 0, ResultDesc: 'Amount mismatch' }
    };
  }

  // Mark request as verified success
  updatePaymentRequest(request.id, {
    status: 'success',
    receipt_reference: mpesaReceipt,
    result_desc: 'M-Pesa payment confirmed successfully.',
    amount_paid: amountPaid,
    phone: payingPhone,
    transaction_date: transDate,
    raw_callback: payload
  });

  return {
    verified: true,
    statusCode: 200,
    paymentRequestId: request.id,
    receipt: mpesaReceipt,
    amount: amountPaid,
    status: 'success',
    response: { ResultCode: 0, ResultDesc: 'Callback processed successfully' }
  };
}

export function hasLiveMpesaCredentials() {
  const config = getInternalConfig('mpesa');
  return !!(config && config.consumer_key && config.consumer_secret && !config.consumer_key.includes('mock'));
}

/**
 * Real callback entry point. Safaricom does not sign callbacks, so the payload alone proves
 * nothing: anyone who knows a CheckoutRequestID could POST "ResultCode 0". Therefore:
 *   - callbacks for a payment that is no longer pending are ignored (no replay / no flipping
 *     a paid request to failed);
 *   - a success claim is only accepted after Safaricom's own stkpushquery confirms it, and the
 *     amount is taken from our request, never from the (forgeable) payload;
 *   - in production mode without live credentials a success claim cannot be confirmed, so it is rejected.
 * Sandbox/demo mode (no live credentials) behaves as before so local testing still works.
 */
export async function confirmAndProcessMpesaCallback(payload, headers = {}, token = null) {
  const callback = payload && payload.Body && payload.Body.stkCallback;
  if (!callback) return verifyAndProcessMpesaCallback(payload, headers);

  const request = findRequestByCheckoutId(callback.CheckoutRequestID) || findRequestByCheckoutId(callback.MerchantRequestID);
  if (!request) return verifyAndProcessMpesaCallback(payload, headers); // acknowledges, changes nothing

  // Safaricom does not sign callbacks. The URL we gave Safaricom carries a secret per-payment
  // token, so only a caller who was handed that exact URL can speak for this payment.
  if (!request.simulated && !callbackTokenValid(request, token)) {
    console.warn(`[M-Pesa Callback] Bad or missing callback token for ${request.id} - rejected`);
    return { verified: false, statusCode: 401, response: { ResultCode: 1, ResultDesc: 'Unauthorized' } };
  }

  // A late successful callback (customer paid just after our 5 minute timeout) must still count,
  // and a payment the status query already confirmed may still need its real receipt number.
  const lateOk = request.status === 'expired';
  const needsReceipt = request.status === 'success' && request.receipt_provisional && Number(callback.ResultCode) === 0;
  if (request.status !== 'pending' && !lateOk && !needsReceipt) {
    return { verified: false, statusCode: 200, response: { ResultCode: 0, ResultDesc: 'Already processed' } };
  }
  if (needsReceipt) {
    const real = ((callback.CallbackMetadata && callback.CallbackMetadata.Item) || []).find(i => i.Name === 'MpesaReceiptNumber');
    if (real && real.Value) {
      updatePaymentRequest(request.id, { receipt_reference: String(real.Value), receipt_provisional: false });
    }
    return { verified: true, statusCode: 200, paymentRequestId: request.id, response: { ResultCode: 0, ResultDesc: 'Receipt recorded' } };
  }

  if (Number(callback.ResultCode) !== 0) {
    return verifyAndProcessMpesaCallback(payload, headers); // failure/cancel claims: low risk, request still pending
  }

  const config = getInternalConfig('mpesa');
  if (hasLiveMpesaCredentials()) {
    const checked = await queryDarajaStkStatus(request.id);
    if (!checked || checked.status !== 'success') {
      console.warn(`[M-Pesa Callback] Success claim for ${request.id} NOT confirmed by Safaricom - ignored`);
      return { verified: false, statusCode: 200, response: { ResultCode: 0, ResultDesc: 'Received, awaiting confirmation' } };
    }
    // Confirmed by Safaricom: record the receipt from the callback but trust OUR amount.
    const items = ((callback.CallbackMetadata && callback.CallbackMetadata.Item) || [])
      .filter(i => i.Name !== 'Amount')
      .concat([{ Name: 'Amount', Value: request.amount }]);
    const trusted = { Body: { stkCallback: { ...callback, CallbackMetadata: { Item: items } } } };
    return verifyAndProcessMpesaCallback(trusted, headers);
  }

  if (config && config.is_production) {
    console.error('[M-Pesa Callback] Production mode but no live credentials - cannot confirm; rejected');
    return { verified: false, statusCode: 503, response: { ResultCode: 1, ResultDesc: 'Cannot verify callback' } };
  }

  return verifyAndProcessMpesaCallback(payload, headers); // sandbox/demo only
}

/**
  * Actively queries Safaricom Daraja STK Push status via stkpushquery API
  */
export async function queryDarajaStkStatus(paymentRequestId) {
  const request = getPaymentRequest(paymentRequestId);
  if (!request) return null;
  if (request.status === 'success' || request.status === 'failed' || request.status === 'cancelled') {
    return request;
  }

  const config = getInternalConfig('mpesa');
  const hasLiveCredentials = config.consumer_key && config.consumer_secret && !config.consumer_key.includes('mock');
  if (!hasLiveCredentials || !request.checkout_request_id || request.simulated) {
    return request;
  }

  try {
    const authHeader = Buffer.from(`${config.consumer_key}:${config.consumer_secret}`).toString('base64');
    const tokenUrl = config.is_production
      ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
      : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

    const tokenRes = await fetch(tokenUrl, { headers: { Authorization: `Basic ${authHeader}` } });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return request;

    const shortcode = config.shortcode || '174379';
    const passkey = config.passkey || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
    const timestamp = formatDarajaTimestamp();
    const password = generateDarajaPassword(shortcode, passkey, timestamp);

    const queryUrl = config.is_production
      ? 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query'
      : 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query';

    const qRes = await fetch(queryUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: request.checkout_request_id
      })
    });

    const qData = await qRes.json();
    if (qData.ResultCode === '0' || qData.ResultCode === 0) {
      updatePaymentRequest(request.id, {
        status: 'success',
        result_desc: qData.ResultDesc || 'The service request is processed successfully.',
        receipt_reference: request.receipt_reference || `MP${Date.now().toString(36).toUpperCase()}`,
        // Safaricom's query does not return the M-Pesa receipt; the callback will replace this.
        receipt_provisional: !request.receipt_reference
      });
    } else if (qData.ResultCode && qData.ResultCode !== '0' && qData.ResultCode !== 0) {
      const isCancelled = qData.ResultCode === '1032' || qData.ResultCode === 1032;
      updatePaymentRequest(request.id, {
        status: isCancelled ? 'cancelled' : 'failed',
        result_desc: qData.ResultDesc || `M-Pesa transaction failed with code ${qData.ResultCode}`
      });
    }
  } catch (err) {
    console.warn('Daraja STK query error:', err.message);
  }

  return getPaymentRequest(paymentRequestId);
}

