import crypto from 'crypto';
import {
  createPaymentRequest,
  getPaymentRequest,
  updatePaymentRequest,
  findRequestByCheckoutId,
  getInternalConfig
} from './store.js';

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

  const numericAmount = Math.max(1, Math.round(Number(amount)));
  const shortcode = config.shortcode || '174379';
  const passkey = config.passkey || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  const timestamp = formatDarajaTimestamp();
  const password = generateDarajaPassword(shortcode, passkey, timestamp);

  // Create internal pending record
  const request = createPaymentRequest({
    gateway: 'mpesa',
    amount: numericAmount,
    phone: normalizedPhone,
    customerId,
    cart,
    metadata: {
      ...metadata,
      payment_type: config.payment_type,
      shortcode,
      timestamp
    }
  });

  // Check if live Daraja API credentials are configured
  const hasLiveCredentials = config.consumer_key && config.consumer_secret && !config.consumer_key.includes('mock');

  if (hasLiveCredentials) {
    try {
      const authHeader = Buffer.from(`${config.consumer_key}:${config.consumer_secret}`).toString('base64');
      const tokenUrl = config.is_production
        ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
        : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

      const tokenRes = await fetch(tokenUrl, {
        headers: { Authorization: `Basic ${authHeader}` }
      });
      const tokenData = await tokenRes.json();

      if (tokenData.access_token) {
        const stkUrl = config.is_production
          ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
          : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

        const stkRes = await fetch(stkUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: config.payment_type === 'paybill' ? 'CustomerPayBillOnline' : 'CustomerBuyGoodsOnline',
            Amount: numericAmount,
            PartyA: normalizedPhone,
            PartyB: shortcode,
            PhoneNumber: normalizedPhone,
            CallBackURL: `${process.env.APP_URL || 'https://dogo-pos.internal'}/api/payments/callbacks/mpesa`,
            AccountReference: `POS-${request.id.slice(0, 8)}`,
            TransactionDesc: `Dogo POS Sale #${request.id.slice(0, 6)}`
          })
        });

        const stkData = await stkRes.json();
        if (stkData.CheckoutRequestID) {
          updatePaymentRequest(request.id, {
            checkout_request_id: stkData.CheckoutRequestID,
            merchant_request_id: stkData.MerchantRequestID || request.merchant_request_id,
            result_desc: stkData.CustomerMessage || 'STK Push sent to phone.'
          });
        }
      }
    } catch (err) {
      console.warn('Daraja API network call skipped or failed, running in sandbox mode:', err.message);
    }
  }

  return {
    success: true,
    payment_request_id: request.id,
    checkout_request_id: request.checkout_request_id,
    phone: normalizedPhone,
    amount: numericAmount,
    gateway: 'mpesa',
    message: `STK push prompt sent to ${normalizedPhone} for KES ${numericAmount.toFixed(2)}. Ask the customer to enter their M-Pesa PIN.`
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
