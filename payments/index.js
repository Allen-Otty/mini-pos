import express from 'express';
import { initiateMpesaStkPush, verifyAndProcessMpesaCallback, confirmAndProcessMpesaCallback, hasLiveMpesaCredentials, formatDarajaTimestamp, queryDarajaStkStatus } from './mpesa.js';
import { initiateKcbPayment, processKcbCallback, buildSimulatedKcbCallback, kcbIsLive } from './kcb.js';
import { initiatePaystackPayment, verifyAndProcessPaystackCallback, confirmAndProcessPaystackCallback, verifyPaystackPayment, paystackIsLive } from './paystack.js';
import { initiateAirtelPayment, verifyAndProcessAirtelCallback, confirmAndProcessAirtelCallback, confirmAirtelRequest, airtelIsLive } from './airtel.js';
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
// What each gateway will actually do right now:
//   live       = production credentials set -> REAL money
//   sandbox    = provider test credentials set -> provider's test environment
//   simulated  = no credentials -> demo only, nothing is sent to any provider
const LIVE_CHECK = { mpesa: hasLiveMpesaCredentials, kcb: kcbIsLive, paystack: paystackIsLive, airtel: airtelIsLive };
function withMode(statuses) {
  return statuses.map(s => {
    const hasCreds = LIVE_CHECK[s.gateway] ? LIVE_CHECK[s.gateway]() : false;
    const prod = !!(getInternalConfig(s.gateway) || {}).is_production;
    return { ...s, mode: !hasCreds ? 'simulated' : (prod ? 'live' : 'sandbox') };
  });
}

paymentRouter.get('/gateways', requireSession, (req, res) => {
  res.json({ success: true, gateways: withMode(getAllGatewayStatuses()) });
});

/**
 * GET /api/payments/config/:gateway?
 */
paymentRouter.get('/config', requireSession, (req, res) => {
  res.json({ success: true, configs: withMode(getAllGatewayStatuses()) });
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

paymentRouter.post('/initiate', requireSession, async (req, res) => {
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
paymentRouter.get('/status/:id', requireSession, async (req, res) => {
  const { id } = req.params;
  let request = getPaymentRequest(id);

  if (!request || !ownsPayment(req, request)) {
    return res.status(404).json({ success: false, error: 'Payment request not found or expired.' });
  }

  // Actively ask the provider for the truth while a payment is still pending (callbacks can be late or lost)
  if (request.status === 'pending' && request.checkout_request_id && !request.simulated) {
    try {
      if (request.gateway === 'mpesa') request = (await queryDarajaStkStatus(id)) || request;
      else if (request.gateway === 'paystack') request = (await verifyPaystackPayment(id)) || request;
      else if (request.gateway === 'airtel') request = (await confirmAirtelRequest(id)) || request;
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
const mpesaCallback = async (req, res) => {
  console.log('[M-Pesa Webhook Received]');
  try {
    // Safaricom does not sign callbacks: the URL carries a secret per-payment token, and a success
    // claim is confirmed with Safaricom's own STK status query before any payment is marked paid.
    const outcome = await confirmAndProcessMpesaCallback(req.body, req.headers, req.params.token);
    res.status(outcome.statusCode).json(outcome.response);
  } catch (err) {
    console.error('[M-Pesa Callback Error]', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Callback processing error' });
  }
};
paymentRouter.post('/callbacks/mpesa/:token', mpesaCallback);
paymentRouter.post('/callbacks/mpesa', mpesaCallback); // legacy untokenized URL: only works for simulated payments

/**
 * POST /api/payments/callbacks/kcb
 * KCB Buni Webhook
 */
const kcbCallback = (req, res) => {
  console.log('[KCB Webhook Received]');
  const outcome = processKcbCallback(req.body, req.params.token);
  res.status(outcome.statusCode).json(outcome.response);
};
paymentRouter.post('/callbacks/kcb/:token', kcbCallback);
paymentRouter.post('/callbacks/kcb', kcbCallback); // untokenized: only works for simulated payments

/**
 * POST /api/payments/callbacks/paystack
 * Paystack Webhook
 */
paymentRouter.post('/callbacks/paystack', async (req, res) => {
  console.log('[Paystack Webhook Received]');
  const outcome = await confirmAndProcessPaystackCallback(req.body, req.rawBody, req.headers);
  res.status(outcome.statusCode).json(outcome.response);
});

/**
 * POST /api/payments/callbacks/airtel
 * Airtel Money Webhook
 */
paymentRouter.post('/callbacks/airtel', async (req, res) => {
  console.log('[Airtel Webhook Received]');
  const outcome = await confirmAndProcessAirtelCallback(req.body, req.headers);
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

  // SECURITY: only payments that were never sent to a provider can be "approved" by hand.
  // A real provider request (sandbox or live) must be completed by the provider itself.
  if (!request.simulated) {
    return res.status(403).json({
      success: false,
      error: 'This payment was sent to the real provider and cannot be simulated. It completes when the provider confirms it.'
    });
  }

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
    simulatedOutcome = processKcbCallback(buildSimulatedKcbCallback(request, { success: isSuccess, receipt }), undefined);
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
