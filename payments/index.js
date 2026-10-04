import express from 'express';
import { initiateMpesaStkPush, verifyAndProcessMpesaCallback, confirmAndProcessMpesaCallback, formatDarajaTimestamp, queryDarajaStkStatus } from './mpesa.js';
import { initiateKcbPayment, verifyAndProcessKcbCallback, generateKcbSignature } from './kcb.js';
import { initiatePaystackPayment, verifyAndProcessPaystackCallback, verifyPaystackPayment } from './paystack.js';
import { initiateAirtelPayment, verifyAndProcessAirtelCallback } from './airtel.js';
import {
  getPaymentRequest,
  updatePaymentRequest,
  getAllGatewayStatuses,
  getGatewayConfig,
  updateGatewayConfig,
  listRecentRequests,
  listAllRequests,
  getTransactionStats,
  linkPaymentToSale,
  findRequestByAnyRef,
  getInternalConfig
} from './store.js';
import crypto from 'crypto';
import { rateLimit as scopedRateLimit, clientIp } from './rate-limit.js';
import { requireBusinessAdmin, requireSession } from './auth.js';

export const paymentRouter = express.Router();

// Minimal in-memory sliding-window rate limiter — no extra dependency needed for a
// single-process dev/local server. Not a substitute for rate limiting at a real
// production edge/CDN if this server is ever deployed publicly, but stops naive
// brute-force/spam against payment initiation and webhook endpoints.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30; // requests per IP per window, per limited route group
const rateBuckets = new Map();
function rateLimit(maxPerMinute = RATE_LIMIT_MAX) {
  return (req, res, next) => {
    const key = (req.ip || req.socket?.remoteAddress || 'unknown') + ':' + maxPerMinute;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || [];
    const fresh = bucket.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length >= maxPerMinute) {
      return res.status(429).json({ success: false, error: 'Too many requests — please slow down and try again shortly.' });
    }
    fresh.push(now);
    rateBuckets.set(key, fresh);
    next();
  };
}
paymentRouter.use(rateLimit());

/**
 * GET /api/payments/gateways
 * Returns all supported payment gateways and their configuration status
 */
paymentRouter.get('/gateways', requireSession, (req, res) => {
  const statuses = getAllGatewayStatuses();
  res.json({ success: true, gateways: statuses });
});

/**
 * GET /api/payments/config/:gateway?
 */
paymentRouter.get('/config', requireSession, (req, res) => {
  const statuses = getAllGatewayStatuses();
  res.json({ success: true, configs: statuses });
});

/**
 * POST /api/payments/config/:gateway
 * Saves settings for a specific gateway
 */
paymentRouter.post('/config/:gateway', requireBusinessAdmin, (req, res) => {
  const { gateway } = req.params;
  if (!['mpesa', 'kcb', 'paystack', 'airtel'].includes(gateway)) {
    return res.status(400).json({ success: false, error: `Unsupported gateway: ${gateway}` });
  }

  const updated = updateGatewayConfig(gateway, req.body);
  res.json({ success: true, gateway: updated, message: `${gateway.toUpperCase()} settings updated successfully.` });
});

/**
 * POST /api/payments/initiate
 * Unified endpoint to initiate payment on any supported gateway
 */
// Tenant isolation: a payment belongs to the business that created it.
function ownsPayment(req, request) {
  return !!(request && req.admin && request.metadata && request.metadata.business_id === req.admin.business_id);
}

// STK-push abuse prevention: each business may start at most 10 payment
// prompts per minute — enough for any real till, painful for harassment.
// (The blanket per-IP limiter above stays as the outer layer.)
const initiateLimiter = scopedRateLimit({
  max: 10,
  windowMs: 60 * 1000,
  keyFn: (req) => (req.admin && req.admin.business_id) || clientIp(req),
  message: 'Too many payment requests. Wait a moment before retrying.'
});
const statusLimiter = scopedRateLimit({
  max: 120,
  windowMs: 60 * 1000,
  keyFn: (req) => (req.admin && req.admin.business_id) || clientIp(req)
});
const callbackLimiter = scopedRateLimit({
  max: 300,
  windowMs: 60 * 1000,
  message: 'Webhook rate limit exceeded'
});

paymentRouter.post('/initiate', requireSession, initiateLimiter, async (req, res) => {
  try {
    const { gateway, phone, account, email, amount, customerId, cart } = req.body;
    // business_id is stamped from the verified login and overrides anything the client sent.
    const metadata = { ...(req.body.metadata || {}), business_id: req.admin.business_id, initiated_by: req.admin.id };

    if (!gateway) {
      return res.status(400).json({ success: false, error: 'Payment gateway is required (mpesa, kcb, paystack, airtel).' });
    }

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Valid payment amount is required.' });
    }

    let result;
    switch (gateway.toLowerCase()) {
      case 'mpesa':
        result = await initiateMpesaStkPush({ phone, amount, customerId, cart, metadata });
        break;

      case 'kcb':
        result = await initiateKcbPayment({ phone, account, amount, customerId, cart, metadata });
        break;

      case 'paystack':
        result = await initiatePaystackPayment({ email, phone, amount, customerId, cart, metadata });
        break;

      case 'airtel':
        result = await initiateAirtelPayment({ phone, amount, customerId, cart, metadata });
        break;

      default:
        return res.status(400).json({ success: false, error: `Gateway '${gateway}' is not supported.` });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('[Payment Initiate Error]', err);
    res.status(400).json({ success: false, error: err.message || 'Payment initiation failed' });
  }
});

/**
 * GET /api/payments/status/:id
 * Polling endpoint used by the POS checkout UI
 */
paymentRouter.get('/status/:id', requireSession, statusLimiter, async (req, res) => {
  const { id } = req.params;
  let request = getPaymentRequest(id);

  if (!request || !ownsPayment(req, request)) {
    return res.status(404).json({ success: false, error: 'Payment request not found or expired.' });
  }

  // Actively query Safaricom Daraja STK status if still pending
  if (request.gateway === 'mpesa' && request.status === 'pending' && request.checkout_request_id) {
    try {
      request = (await queryDarajaStkStatus(id)) || request;
    } catch (e) {}
  }

  // Actively confirm with Paystack if still pending (the webhook alone is not trusted)
  if (request.gateway === 'paystack' && request.status === 'pending' && request.checkout_request_id) {
    try {
      request = (await verifyPaystackPayment(id)) || request;
    } catch (e) {}
  }

  res.json({
    success: true,
    data: {
      id: request.id,
      gateway: request.gateway,
      status: request.status,
      amount: request.amount,
      currency: request.currency,
      phone: request.phone,
      checkout_request_id: request.checkout_request_id,
      receipt_reference: request.receipt_reference,
      result_desc: request.result_desc,
      created_at: request.created_at,
      updated_at: request.updated_at
    }
  });
});

/**
 * GET /api/payments/recent
 * Returns recent transactions for platform dashboard & audit
 */
paymentRouter.get('/recent', requireBusinessAdmin, (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 20);
  res.json({ success: true, transactions: listRecentRequests(limit, req.admin.business_id) });
});

/**
 * GET /api/payments/transactions
 * Comprehensive ledger endpoint for Gateway Transactions table view with search, filter, date range, and stats
 */
paymentRouter.get('/transactions', requireBusinessAdmin, (req, res) => {
  const { gateway = 'all', status = 'all', search = '', startDate = '', endDate = '', limit = 100 } = req.query;
  const transactions = listAllRequests({
    gateway,
    status,
    search,
    startDate,
    endDate,
    limit: Math.min(200, Number(limit) || 100),
    businessId: req.admin.business_id
  });
  const stats = getTransactionStats(transactions);

  res.json({
    success: true,
    transactions,
    stats,
    total: transactions.length
  });
});

/**
 * GET /api/payments/transaction/:ref
 * Looks up a transaction by external reference, checkout ID, or internal receipt number
 */
paymentRouter.get('/transaction/:ref', requireBusinessAdmin, (req, res) => {
  const { ref } = req.params;
  const transaction = findRequestByAnyRef(ref);

  if (!transaction || !ownsPayment(req, transaction)) {
    return res.status(404).json({ success: false, error: 'Transaction not found for reference: ' + ref });
  }

  res.json({ success: true, transaction });
});

/**
 * POST /api/payments/link-sale
 * Links an external payment request to an internal sale receipt number
 */
paymentRouter.post('/link-sale', requireSession, (req, res) => {
  const { payment_request_id, receipt_no, sale_id } = req.body;
  if (!payment_request_id || !receipt_no) {
    return res.status(400).json({ success: false, error: 'payment_request_id and receipt_no are required' });
  }

  if (!ownsPayment(req, getPaymentRequest(payment_request_id))) {
    return res.status(404).json({ success: false, error: 'Payment request not found: ' + payment_request_id });
  }

  const linked = linkPaymentToSale(payment_request_id, receipt_no, sale_id);
  if (!linked) {
    return res.status(404).json({ success: false, error: 'Payment request not found: ' + payment_request_id });
  }

  res.json({ success: true, transaction: linked, message: `Linked ${linked.receipt_reference || linked.checkout_request_id} to ${receipt_no}` });
});

/**
 * POST /api/payments/callbacks/mpesa
 * Safaricom Daraja Webhook
 */
paymentRouter.post('/callbacks/mpesa', callbackLimiter, async (req, res) => {
  console.log('[M-Pesa Webhook Received]');
  try {
    // Safaricom does not sign callbacks, so a success claim is confirmed with Safaricom's
    // own STK status query before any payment is marked paid.
    const outcome = await confirmAndProcessMpesaCallback(req.body, req.headers);
    res.status(outcome.statusCode).json(outcome.response);
  } catch (err) {
    console.error('[M-Pesa Callback Error]', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Callback processing error' });
  }
});

/**
 * POST /api/payments/callbacks/kcb
 * KCB Buni Webhook
 */
paymentRouter.post('/callbacks/kcb', callbackLimiter, (req, res) => {
  console.log('[KCB Webhook Received]');
  const outcome = verifyAndProcessKcbCallback(req.body, req.rawBody, req.headers);
  res.status(outcome.statusCode).json(outcome.response);
});

/**
 * POST /api/payments/callbacks/paystack
 * Paystack Webhook
 */
paymentRouter.post('/callbacks/paystack', callbackLimiter, (req, res) => {
  console.log('[Paystack Webhook Received]');
  const outcome = verifyAndProcessPaystackCallback(req.body, req.rawBody, req.headers);
  res.status(outcome.statusCode).json(outcome.response);
});

/**
 * POST /api/payments/callbacks/airtel
 * Airtel Money Webhook
 */
paymentRouter.post('/callbacks/airtel', callbackLimiter, (req, res) => {
  console.log('[Airtel Webhook Received]');
  const outcome = verifyAndProcessAirtelCallback(req.body, req.headers);
  res.status(outcome.statusCode).json(outcome.response);
});

/**
 * POST /api/payments/simulate/:id
 * Dedicated sandbox simulation endpoint that runs through the exact callback verification engine!
 */
paymentRouter.post('/simulate/:id', requireBusinessAdmin, (req, res) => {
  // The simulator fabricates provider-signed callbacks. In production it is a payment
  // forgery tool, so it only exists when the process is not running in production mode.
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: 'Not available in production.' });
  }
  const { id } = req.params;
  const { action = 'approve', receipt } = req.body;
  const request = getPaymentRequest(id);

  if (!request || !ownsPayment(req, request)) {
    return res.status(404).json({ success: false, error: 'Payment request not found.' });
  }

  if (request.status !== 'pending') {
    return res.status(400).json({ success: false, error: `Request is already in state: ${request.status}` });
  }

  const gateway = request.gateway;
  const gwConfig = getInternalConfig(gateway) || {};

  // SECURITY: never allow a simulated "successful payment" to be injected against a
  // gateway that is configured for real production money — sandbox/test mode only,
  // even for a verified Admin.
  if (gwConfig.is_production) {
    return res.status(403).json({
      success: false,
      error: `${gateway.toUpperCase()} is in production mode — simulated callbacks are disabled. Switch to sandbox to test.`
    });
  }
  let simulatedOutcome;

  if (gateway === 'mpesa') {
    const isSuccess = action === 'approve';
    const fakeReceipt = receipt || `QHD${Math.floor(1000000 + Math.random() * 9000000)}XA`;
    const payload = {
      Body: {
        stkCallback: {
          MerchantRequestID: request.merchant_request_id,
          CheckoutRequestID: request.checkout_request_id,
          ResultCode: isSuccess ? 0 : (action === 'cancel' ? 1032 : 1037),
          ResultDesc: isSuccess ? 'The service request is processed successfully.' : 'Request cancelled or timed out by customer.',
          CallbackMetadata: isSuccess ? {
            Item: [
              { Name: 'Amount', Value: request.amount },
              { Name: 'MpesaReceiptNumber', Value: fakeReceipt },
              { Name: 'TransactionDate', Value: formatDarajaTimestamp() },
              { Name: 'PhoneNumber', Value: request.phone || '254712345678' }
            ]
          } : null
        }
      }
    };
    simulatedOutcome = verifyAndProcessMpesaCallback(payload, {});
  } else if (gateway === 'kcb') {
    const isSuccess = action === 'approve';
    const fakeReceipt = receipt || `KCB-${Math.floor(100000 + Math.random() * 900000)}`;
    const payload = {
      transactionReference: request.checkout_request_id,
      merchantCode: 'KCB-DEMO-001',
      status: isSuccess ? 'SUCCESS' : 'FAILED',
      amount: request.amount,
      currency: 'KES',
      kcbReference: fakeReceipt,
      channel: 'VOOMA',
      customerMsisdn: request.phone || '254712345678',
      timestamp: new Date().toISOString()
    };

    const kcbConfig = getInternalConfig('kcb');
    const rawBuf = Buffer.from(JSON.stringify(payload));
    const toSign = `${payload.timestamp}.${rawBuf.toString('utf8')}`;
    const sig = generateKcbSignature(toSign, kcbConfig.shared_secret);

    simulatedOutcome = verifyAndProcessKcbCallback(payload, rawBuf, {
      'x-kcb-signature': sig,
      'x-timestamp': payload.timestamp
    });
  } else if (gateway === 'paystack') {
    const isSuccess = action === 'approve';
    const fakeReceipt = receipt || `PSTK_${Date.now().toString(36).toUpperCase()}`;
    const payload = {
      event: isSuccess ? 'charge.success' : 'charge.failed',
      data: {
        id: Math.floor(100000 + Math.random() * 900000),
        reference: request.checkout_request_id,
        amount: request.amount * 100, // in subunits
        currency: 'KES',
        channel: 'mobile_money',
        status: isSuccess ? 'success' : 'failed',
        customer: { email: request.metadata?.email || 'customer@dogopos.app' }
      }
    };

    const pstkConfig = getInternalConfig('paystack');
    const rawBuf = Buffer.from(JSON.stringify(payload));
    const sig = crypto.createHmac('sha512', pstkConfig.secret_key).update(rawBuf).digest('hex');

    simulatedOutcome = verifyAndProcessPaystackCallback(payload, rawBuf, {
      'x-paystack-signature': sig
    });
  } else if (gateway === 'airtel') {
    const isSuccess = action === 'approve';
    const fakeReceipt = receipt || `AIR${Date.now().toString(36).toUpperCase()}`;
    const payload = {
      transaction: {
        reference_id: request.checkout_request_id,
        status: isSuccess ? 'TS' : 'TF',
        amount: request.amount,
        currency: 'KES',
        airtel_money_id: fakeReceipt,
        message: isSuccess ? 'Transaction Success' : 'Customer cancelled PIN prompt'
      }
    };
    simulatedOutcome = verifyAndProcessAirtelCallback(payload, {});
  }

  const updatedReq = getPaymentRequest(id);
  res.json({
    success: true,
    simulatedOutcome,
    data: updatedReq
  });
});
