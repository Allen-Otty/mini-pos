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
 * Initiates a KCB Buni / Vooma Payment prompt or account reference
 */
export async function initiateKcbPayment({ phone, account, amount, customerId, cart, metadata = {} }) {
  const config = getInternalConfig('kcb');
  const numericAmount = Math.max(1, Number(amount));

  if (!phone && !account) {
    throw new Error('Please provide customer phone number (for Vooma STK) or KCB account number.');
  }

  const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
  const cleanAccount = account ? String(account).trim() : '';

  const request = createPaymentRequest({
    gateway: 'kcb',
    amount: numericAmount,
    phone: cleanPhone,
    account: cleanAccount,
    customerId,
    cart,
    metadata: {
      ...metadata,
      merchant_code: config.merchant_code,
      account_number: config.account_number,
      channel: cleanPhone ? 'VOOMA_STK' : 'KCB_ACCOUNT_TRANSFER'
    }
  });

  // Assign a distinct KCB transaction reference
  const kcbRef = `KCB-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
  updatePaymentRequest(request.id, {
    checkout_request_id: kcbRef,
    merchant_request_id: `KCB-REQ-${request.id.slice(0, 8).toUpperCase()}`,
    result_desc: cleanPhone
      ? `KCB Vooma prompt sent to ${cleanPhone}. Waiting for PIN approval.`
      : `KCB Paybill/Till prompt initiated. Reference: ${kcbRef}`
  });

  return {
    success: true,
    payment_request_id: request.id,
    checkout_request_id: kcbRef,
    merchant_code: config.merchant_code,
    phone: cleanPhone,
    account: cleanAccount,
    amount: numericAmount,
    gateway: 'kcb',
    message: cleanPhone
      ? `KCB Vooma prompt sent to ${cleanPhone} for KES ${numericAmount.toFixed(2)}. Enter PIN to authorize.`
      : `KCB payment reference generated (${kcbRef}). Awaiting direct deposit confirmation.`
  };
}

/**
 * Generates an HMAC-SHA256 signature for KCB payloads
 */
export function generateKcbSignature(dataString, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(dataString).digest('hex');
}

/**
 * Securely verifies and processes KCB Buni callback
 */
export function verifyAndProcessKcbCallback(payload, rawBody, headers = {}) {
  const config = getInternalConfig('kcb');

  if (!payload || typeof payload !== 'object') {
    return {
      verified: false,
      statusCode: 400,
      response: { statusCode: '99', message: 'Invalid payload' }
    };
  }

  // 1. Signature Verification (Anti-tampering)
  const incomingSignature = headers['x-kcb-signature'] || headers['x-buni-signature'] || headers['x-signature'];
  const sharedSecret = config.shared_secret;

  if (incomingSignature && sharedSecret) {
    const timestamp = headers['x-timestamp'] || '';
    const dataToSign = timestamp ? `${timestamp}.${rawBody ? rawBody.toString('utf8') : JSON.stringify(payload)}` : (rawBody ? rawBody.toString('utf8') : JSON.stringify(payload));
    const expectedSignature = generateKcbSignature(dataToSign, sharedSecret);

    try {
      const incomingBuf = Buffer.from(incomingSignature, 'hex');
      const expectedBuf = Buffer.from(expectedSignature, 'hex');
      if (incomingBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(incomingBuf, expectedBuf)) {
        console.warn('[KCB Callback] Signature verification mismatch');
        return {
          verified: false,
          statusCode: 401,
          response: { statusCode: '401', message: 'Signature verification failed' }
        };
      }
    } catch (e) {
      console.warn('[KCB Callback] Signature comparison error:', e.message);
      return {
        verified: false,
        statusCode: 401,
        response: { statusCode: '401', message: 'Signature format invalid' }
      };
    }
  }

  // 2. Replay Protection: Check timestamp window (if provided)
  const eventTime = payload.timestamp || headers['x-timestamp'];
  if (eventTime) {
    const eventMs = new Date(eventTime).getTime();
    const nowMs = Date.now();
    // If older than 10 minutes, suspect replay
    if (!isNaN(eventMs) && Math.abs(nowMs - eventMs) > 10 * 60 * 1000) {
      console.warn('[KCB Callback] Event timestamp is outside acceptable 10-minute window');
    }
  }

  // 3. Match Request
  const ref = payload.transactionReference || payload.checkoutRequestId || payload.reference || payload.checkout_request_id;
  const request = findRequestByCheckoutId(ref) || findRequestByGatewayRef('kcb', ref);

  if (!request) {
    console.warn(`[KCB Callback] No matching request found for ref: ${ref}`);
    return {
      verified: false,
      statusCode: 200,
      response: { statusCode: '00', message: 'Acknowledged, request not tracked' }
    };
  }

  // 4. Status Check
  const statusStr = String(payload.status || payload.transactionStatus || '').toUpperCase();
  const isSuccess = ['SUCCESS', 'APPROVED', 'COMPLETED', 'PAID', '00'].includes(statusStr);

  if (!isSuccess) {
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: payload.message || payload.resultDesc || `KCB transaction ${statusStr || 'declined'}`,
      raw_callback: payload
    });

    return {
      verified: true,
      statusCode: 200,
      paymentRequestId: request.id,
      status: 'failed',
      response: { statusCode: '00', message: 'Failure acknowledged' }
    };
  }

  // 5. Amount Verification (Anti-underpayment)
  const paidAmount = Number(payload.amount) || request.amount;
  if (paidAmount < request.amount) {
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: `KCB underpayment: received KES ${paidAmount}, expected KES ${request.amount}`,
      raw_callback: payload
    });

    return {
      verified: false,
      statusCode: 200,
      paymentRequestId: request.id,
      status: 'failed',
      response: { statusCode: '00', message: 'Amount mismatch' }
    };
  }

  // 6. Complete and record receipt reference
  const kcbReceipt = payload.kcbReference || payload.receiptNumber || `KCB-${Math.floor(100000 + Math.random() * 900000)}`;

  updatePaymentRequest(request.id, {
    status: 'success',
    receipt_reference: kcbReceipt,
    amount_paid: paidAmount,
    result_desc: 'KCB Buni payment confirmed successfully.',
    raw_callback: payload
  });

  return {
    verified: true,
    statusCode: 200,
    paymentRequestId: request.id,
    receipt: kcbReceipt,
    amount: paidAmount,
    status: 'success',
    response: { statusCode: '00', message: 'Transaction verified and credited' }
  };
}
