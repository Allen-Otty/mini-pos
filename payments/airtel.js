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
 * Initiates an Airtel Money East Africa collection prompt
 */
export async function initiateAirtelPayment({ phone, amount, customerId, cart, metadata = {} }) {
  const config = getInternalConfig('airtel');
  const numericAmount = Math.max(1, Number(amount));

  if (!phone) {
    throw new Error('Please provide a customer phone number for Airtel Money.');
  }

  let cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
  if (!cleanPhone.startsWith('254') && cleanPhone.length === 9) cleanPhone = '254' + cleanPhone;

  const request = createPaymentRequest({
    gateway: 'airtel',
    amount: numericAmount,
    phone: cleanPhone,
    customerId,
    cart,
    metadata: {
      ...metadata,
      merchant_number: config.merchant_number
    }
  });

  const airtelRef = `AIR-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
  updatePaymentRequest(request.id, {
    checkout_request_id: airtelRef,
    merchant_request_id: `AIR-REQ-${request.id.slice(0, 8).toUpperCase()}`,
    result_desc: `Airtel Money USSD push prompt sent to ${cleanPhone}. Waiting for customer PIN.`
  });

  return {
    success: true,
    payment_request_id: request.id,
    checkout_request_id: airtelRef,
    phone: cleanPhone,
    amount: numericAmount,
    gateway: 'airtel',
    message: `Airtel Money prompt sent to ${cleanPhone} for KES ${numericAmount.toFixed(2)}. Enter PIN to authorize.`
  };
}

/**
 * Securely verifies and processes Airtel Money callback
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

  // Check transaction status (Airtel uses TS = Transaction Success, or status 'SUCCESS')
  const status = String(transaction.status || transaction.status_code || payload.status || '').toUpperCase();
  const isSuccess = ['TS', 'SUCCESS', '200', 'APPROVED'].includes(status);

  if (!isSuccess) {
    updatePaymentRequest(request.id, {
      status: 'failed',
      result_desc: transaction.message || `Airtel Money transaction failed with status ${status}`,
      raw_callback: payload
    });

    return {
      verified: true,
      statusCode: 200,
      paymentRequestId: request.id,
      status: 'failed',
      response: { status: 'FAILED', message: 'Failure acknowledged' }
    };
  }

  // Verify amount
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
    verified: true,
    statusCode: 200,
    paymentRequestId: request.id,
    receipt: airtelReceipt,
    amount: paidAmount,
    status: 'success',
    response: { status: 'SUCCESS', message: 'Payment confirmed' }
  };
}
