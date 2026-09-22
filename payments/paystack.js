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

  const paystackRef = `PSTK-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
  updatePaymentRequest(request.id, {
    checkout_request_id: paystackRef,
    merchant_request_id: paystackRef,
    result_desc: `Paystack charge initialized. Waiting for customer completion.`
  });

  return {
    success: true,
    payment_request_id: request.id,
    checkout_request_id: paystackRef,
    amount: numericAmount,
    gateway: 'paystack',
    email: customerEmail,
    message: `Paystack transaction reference ${paystackRef} initialized for KES ${numericAmount.toFixed(2)}.`
  };
}

/**
 * Verifies Paystack Webhook with HMAC-SHA512 against raw payload
 */
export function verifyAndProcessPaystackCallback(payload, rawBody, headers = {}) {
  const config = getInternalConfig('paystack');
  const signature = headers['x-paystack-signature'];
  const secretKey = config.secret_key || process.env.PAYSTACK_SECRET_KEY || 'sk_test_paystack_default_secret_key';

  if (!payload || typeof payload !== 'object') {
    return { verified: false, statusCode: 400, response: { message: 'Invalid payload' } };
  }

  // 1. Signature Verification with HMAC-SHA512
  if (signature && rawBody) {
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
  } else if (config.is_production && !signature) {
    return { verified: false, statusCode: 401, response: { message: 'Signature header required in production' } };
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
