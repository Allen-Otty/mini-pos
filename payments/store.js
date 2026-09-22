import crypto from 'crypto';

// In-memory persistent store for active and completed payment requests
const paymentRequests = new Map();

// Configuration store for payment gateways (in-memory with sensible defaults / env overrides)
const gatewayConfigs = {
  mpesa: {
    enabled: true,
    payment_type: 'till', // 'till', 'paybill', 'pochi'
    shortcode: process.env.MPESA_SHORTCODE || '174379',
    consumer_key: process.env.MPESA_CONSUMER_KEY || '',
    consumer_secret: process.env.MPESA_CONSUMER_SECRET || '',
    passkey: process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
    is_production: process.env.MPESA_ENVIRONMENT === 'production',
    callback_url: '/api/payments/callbacks/mpesa'
  },
  kcb: {
    enabled: true,
    merchant_code: process.env.KCB_MERCHANT_CODE || 'KCB-DEMO-001',
    app_key: process.env.KCB_APP_KEY || '',
    app_secret: process.env.KCB_APP_SECRET || '',
    shared_secret: process.env.KCB_SHARED_SECRET || 'kcb_buni_webhook_secret_key_2026',
    account_number: process.env.KCB_ACCOUNT || '1234567890',
    is_production: process.env.KCB_ENVIRONMENT === 'production',
    callback_url: '/api/payments/callbacks/kcb'
  },
  paystack: {
    enabled: true,
    public_key: process.env.PAYSTACK_PUBLIC_KEY || '',
    secret_key: process.env.PAYSTACK_SECRET_KEY || 'sk_test_paystack_default_secret_key',
    is_production: false,
    callback_url: '/api/payments/callbacks/paystack'
  },
  airtel: {
    enabled: true,
    client_id: process.env.AIRTEL_CLIENT_ID || '',
    client_secret: process.env.AIRTEL_CLIENT_SECRET || '',
    merchant_number: process.env.AIRTEL_MERCHANT_NUMBER || 'AIRTEL_TILL_882',
    encryption_key: process.env.AIRTEL_ENCRYPTION_KEY || 'airtel_sec_key_2026',
    is_production: false,
    callback_url: '/api/payments/callbacks/airtel'
  }
};

/**
 * Pre-seeds realistic demonstration records with external transaction references
 * linked directly to internal sales records.
 */
function seedDemoTransactions() {
  if (paymentRequests.size > 0) return;
  const now = Date.now();
  const sampleData = [
    {
      id: 'gw-mpesa-001',
      gateway: 'mpesa',
      amount: 1850,
      currency: 'KES',
      phone: '254712345678',
      account: '',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'MPESA-REQ-001',
      checkout_request_id: 'CHK-MPE-9A82B1',
      receipt_reference: 'QHD9218402XA',
      internal_receipt_no: 'RC-0001',
      internal_sale_id: 'sale-mpesa-001',
      result_desc: 'M-Pesa payment confirmed successfully via Daraja STK push.',
      created_at: new Date(now - 1000 * 60 * 25).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 24).toISOString(),
      expires_at: new Date(now + 1000 * 60 * 5).toISOString(),
      amount_paid: 1850,
      metadata: { payment_type: 'till', shortcode: '174379', verified_by: 'daraja_stk_callback' }
    },
    {
      id: 'gw-kcb-002',
      gateway: 'kcb',
      amount: 3400,
      currency: 'KES',
      phone: '254722556677',
      account: '1100223344',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'KCB-REQ-002',
      checkout_request_id: 'KCB-VOOMA-7104',
      receipt_reference: 'KCB-749102',
      internal_receipt_no: 'RC-0002',
      internal_sale_id: 'sale-kcb-002',
      result_desc: 'KCB Vooma payment confirmed and HMAC-SHA256 signature verified.',
      created_at: new Date(now - 1000 * 60 * 65).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 64).toISOString(),
      expires_at: new Date(now + 1000 * 60 * 5).toISOString(),
      amount_paid: 3400,
      metadata: { merchant_code: 'KCB-DEMO-001', channel: 'VOOMA', hmac_verified: true }
    },
    {
      id: 'gw-paystack-003',
      gateway: 'paystack',
      amount: 2200,
      currency: 'KES',
      phone: '254708990011',
      account: '',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'PSTK-REQ-003',
      checkout_request_id: 'PSTK-REF-994102',
      receipt_reference: 'PSTK-REF-994102',
      internal_receipt_no: 'RC-0003',
      internal_sale_id: 'sale-pstk-003',
      result_desc: 'Paystack payment confirmed via mobile_money, HMAC-SHA512 valid.',
      created_at: new Date(now - 1000 * 60 * 120).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 119).toISOString(),
      expires_at: new Date(now + 1000 * 60 * 5).toISOString(),
      amount_paid: 2200,
      metadata: { email: 'jane.shopper@gmail.com', channel: 'mobile_money', signature_verified: true }
    },
    {
      id: 'gw-mpesa-004',
      gateway: 'mpesa',
      amount: 950,
      currency: 'KES',
      phone: '254701234567',
      account: '',
      customer_id: null,
      status: 'pending',
      merchant_request_id: 'MPESA-REQ-004',
      checkout_request_id: 'CHK-MPE-332910',
      receipt_reference: null,
      internal_receipt_no: null,
      internal_sale_id: null,
      result_desc: 'STK push prompt sent to handset. Awaiting customer PIN authorization.',
      created_at: new Date(now - 1000 * 60 * 3).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 3).toISOString(),
      expires_at: new Date(now + 1000 * 60 * 2).toISOString(),
      metadata: { payment_type: 'till', shortcode: '174379' }
    },
    {
      id: 'gw-kcb-005',
      gateway: 'kcb',
      amount: 1400,
      currency: 'KES',
      phone: '254799887766',
      account: '2233445566',
      customer_id: null,
      status: 'failed',
      merchant_request_id: 'KCB-REQ-005',
      checkout_request_id: 'KCB-VOOMA-9920',
      receipt_reference: null,
      internal_receipt_no: null,
      internal_sale_id: null,
      result_desc: 'Customer cancelled transaction or entered incorrect Vooma PIN.',
      created_at: new Date(now - 1000 * 60 * 180).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 179).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 175).toISOString(),
      metadata: { merchant_code: 'KCB-DEMO-001', channel: 'VOOMA', failure_reason: 'USER_CANCELLED' }
    },
    {
      id: 'gw-paystack-006',
      gateway: 'paystack',
      amount: 5200,
      currency: 'KES',
      phone: '254711223344',
      account: '',
      customer_id: null,
      status: 'failed',
      merchant_request_id: 'PSTK-REQ-006',
      checkout_request_id: 'PSTK-FAIL-7721',
      receipt_reference: null,
      internal_receipt_no: null,
      internal_sale_id: null,
      result_desc: 'Card issuer declined charge: Insufficient funds in linked debit account.',
      created_at: new Date(now - 1000 * 60 * 240).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 239).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 235).toISOString(),
      metadata: { email: 'alex.buyer@business.co.ke', failure_code: 'insufficient_funds' }
    },
    // --- YESTERDAY (Day before today) ---
    {
      id: 'gw-mpesa-007',
      gateway: 'mpesa',
      amount: 4500,
      currency: 'KES',
      phone: '254718223344',
      account: '',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'MPESA-REQ-007',
      checkout_request_id: 'CHK-MPE-882103',
      receipt_reference: 'QHD8821034BC',
      internal_receipt_no: 'RC-0091',
      internal_sale_id: 'sale-mpesa-091',
      result_desc: 'M-Pesa payment confirmed successfully via Daraja STK push.',
      created_at: new Date(now - 1000 * 60 * 60 * 26).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 26).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 25).toISOString(),
      amount_paid: 4500,
      metadata: { payment_type: 'till', shortcode: '174379', verified_by: 'daraja_stk_callback' }
    },
    {
      id: 'gw-airtel-008',
      gateway: 'airtel',
      amount: 1200,
      currency: 'KES',
      phone: '254733445566',
      account: 'AIR-9920',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'AIR-REQ-008',
      checkout_request_id: 'AIR-CHK-992014',
      receipt_reference: 'AIR-992014',
      internal_receipt_no: 'RC-0092',
      internal_sale_id: 'sale-airtel-092',
      result_desc: 'Airtel Money transaction confirmed and token verified.',
      created_at: new Date(now - 1000 * 60 * 60 * 30).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 30).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 29).toISOString(),
      amount_paid: 1200,
      metadata: { channel: 'AIRTEL_PUSH', partner_id: 'AIRTEL-DEMO' }
    },
    {
      id: 'gw-kcb-009',
      gateway: 'kcb',
      amount: 2800,
      currency: 'KES',
      phone: '254720998811',
      account: '5566778899',
      customer_id: null,
      status: 'failed',
      merchant_request_id: 'KCB-REQ-009',
      checkout_request_id: 'KCB-VOOMA-6612',
      receipt_reference: null,
      internal_receipt_no: null,
      internal_sale_id: null,
      result_desc: 'Vooma request timed out. Customer did not approve prompt.',
      created_at: new Date(now - 1000 * 60 * 60 * 34).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 33).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 32).toISOString(),
      metadata: { failure_reason: 'TIMEOUT' }
    },
    // --- EARLIER THIS WEEK (3-4 Days ago) ---
    {
      id: 'gw-paystack-010',
      gateway: 'paystack',
      amount: 8400,
      currency: 'KES',
      phone: '254700112233',
      account: '',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'PSTK-REQ-010',
      checkout_request_id: 'PSTK-REF-881230',
      receipt_reference: 'PSTK-REF-881230',
      internal_receipt_no: 'RC-0085',
      internal_sale_id: 'sale-pstk-085',
      result_desc: 'Paystack checkout succeeded via Mastercard with 3DS authorization.',
      created_at: new Date(now - 1000 * 60 * 60 * 24 * 3).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 24 * 3).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 24 * 3).toISOString(),
      amount_paid: 8400,
      metadata: { email: 'builders.supply@co.ke', channel: 'card', brand: 'Mastercard' }
    },
    {
      id: 'gw-mpesa-011',
      gateway: 'mpesa',
      amount: 1650,
      currency: 'KES',
      phone: '254714556677',
      account: '',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'MPESA-REQ-011',
      checkout_request_id: 'CHK-MPE-771920',
      receipt_reference: 'QHD7719201LK',
      internal_receipt_no: 'RC-0086',
      internal_sale_id: 'sale-mpesa-086',
      result_desc: 'M-Pesa payment confirmed successfully via Daraja STK push.',
      created_at: new Date(now - 1000 * 60 * 60 * 24 * 4).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 24 * 4).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 24 * 4).toISOString(),
      amount_paid: 1650,
      metadata: { payment_type: 'till', shortcode: '174379' }
    },
    // --- LAST WEEK (7 - 10 Days ago) ---
    {
      id: 'gw-mpesa-012',
      gateway: 'mpesa',
      amount: 6200,
      currency: 'KES',
      phone: '254722889900',
      account: '',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'MPESA-REQ-012',
      checkout_request_id: 'CHK-MPE-661902',
      receipt_reference: 'QGC6619021AA',
      internal_receipt_no: 'RC-0074',
      internal_sale_id: 'sale-mpesa-074',
      result_desc: 'M-Pesa payment confirmed successfully via Daraja STK push.',
      created_at: new Date(now - 1000 * 60 * 60 * 24 * 8).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 24 * 8).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 24 * 8).toISOString(),
      amount_paid: 6200,
      metadata: { payment_type: 'till', shortcode: '174379' }
    },
    {
      id: 'gw-kcb-013',
      gateway: 'kcb',
      amount: 12500,
      currency: 'KES',
      phone: '254799001122',
      account: '9988776655',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'KCB-REQ-013',
      checkout_request_id: 'KCB-VOOMA-5542',
      receipt_reference: 'KCB-554219',
      internal_receipt_no: 'RC-0075',
      internal_sale_id: 'sale-kcb-075',
      result_desc: 'KCB Vooma merchant payment settled.',
      created_at: new Date(now - 1000 * 60 * 60 * 24 * 9).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 24 * 9).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 24 * 9).toISOString(),
      amount_paid: 12500,
      metadata: { merchant_code: 'KCB-DEMO-001', channel: 'VOOMA' }
    },
    {
      id: 'gw-airtel-014',
      gateway: 'airtel',
      amount: 3100,
      currency: 'KES',
      phone: '254738112233',
      account: 'AIR-8810',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'AIR-REQ-014',
      checkout_request_id: 'AIR-CHK-881023',
      receipt_reference: 'AIR-881023',
      internal_receipt_no: 'RC-0076',
      internal_sale_id: 'sale-airtel-076',
      result_desc: 'Airtel Money transaction confirmed and token verified.',
      created_at: new Date(now - 1000 * 60 * 60 * 24 * 10).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 24 * 10).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 24 * 10).toISOString(),
      amount_paid: 3100,
      metadata: { channel: 'AIRTEL_PUSH' }
    },
    {
      id: 'gw-paystack-015',
      gateway: 'paystack',
      amount: 4900,
      currency: 'KES',
      phone: '254719887766',
      account: '',
      customer_id: null,
      status: 'failed',
      merchant_request_id: 'PSTK-REQ-015',
      checkout_request_id: 'PSTK-FAIL-4401',
      receipt_reference: null,
      internal_receipt_no: null,
      internal_sale_id: null,
      result_desc: 'Card authentication failed (3DS cancelled by cardholder).',
      created_at: new Date(now - 1000 * 60 * 60 * 24 * 11).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 24 * 11).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 24 * 11).toISOString(),
      metadata: { failure_code: '3ds_cancelled' }
    },
    // --- 2 WEEKS AGO ---
    {
      id: 'gw-mpesa-016',
      gateway: 'mpesa',
      amount: 15000,
      currency: 'KES',
      phone: '254721443322',
      account: '',
      customer_id: null,
      status: 'success',
      merchant_request_id: 'MPESA-REQ-016',
      checkout_request_id: 'CHK-MPE-551920',
      receipt_reference: 'QGB5519201ZZ',
      internal_receipt_no: 'RC-0050',
      internal_sale_id: 'sale-mpesa-050',
      result_desc: 'M-Pesa bulk contractor purchase confirmed.',
      created_at: new Date(now - 1000 * 60 * 60 * 24 * 16).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 60 * 24 * 16).toISOString(),
      expires_at: new Date(now - 1000 * 60 * 60 * 24 * 16).toISOString(),
      amount_paid: 15000,
      metadata: { payment_type: 'till', shortcode: '174379' }
    }
  ];

  sampleData.forEach(d => paymentRequests.set(d.id, d));
}
seedDemoTransactions();

/**
 * Creates a new payment request record in pending state
 */
export function createPaymentRequest({ gateway, amount, phone = '', account = '', customerId = null, cart = [], metadata = {} }) {
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes validity

  const record = {
    id,
    gateway,
    amount: Number(amount) || 0,
    currency: 'KES',
    phone: phone.trim(),
    account: account.trim(),
    customer_id: customerId,
    cart: Array.isArray(cart) ? cart : [],
    status: 'pending', // 'pending' | 'success' | 'failed' | 'cancelled' | 'expired'
    merchant_request_id: `${gateway.toUpperCase()}-REQ-${Date.now().toString(36).toUpperCase()}`,
    checkout_request_id: `CHK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
    receipt_reference: null,
    result_desc: 'Payment prompt initiated, waiting for customer confirmation.',
    metadata: { ...metadata },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };

  paymentRequests.set(id, record);
  return record;
}

/**
 * Retrieves a payment request by ID
 */
export function getPaymentRequest(id) {
  if (!id) return null;
  const req = paymentRequests.get(id);
  if (!req) return null;

  // Auto-expire if pending and past expiration
  if (req.status === 'pending' && new Date() > new Date(req.expires_at)) {
    req.status = 'expired';
    req.result_desc = 'Payment request timed out without customer action.';
    req.updated_at = new Date().toISOString();
  }

  return req;
}

/**
 * Updates a payment request with new status and details
 */
export function updatePaymentRequest(id, updates) {
  const req = paymentRequests.get(id);
  if (!req) return null;

  Object.assign(req, updates, { updated_at: new Date().toISOString() });
  return req;
}

/**
 * Finds a payment request by checkout request ID or merchant request ID
 */
export function findRequestByCheckoutId(checkoutRequestId) {
  for (const req of paymentRequests.values()) {
    if (req.checkout_request_id === checkoutRequestId || req.merchant_request_id === checkoutRequestId) {
      return req;
    }
  }
  return null;
}

/**
 * Finds by gateway and external reference
 */
export function findRequestByGatewayRef(gateway, ref) {
  for (const req of paymentRequests.values()) {
    if (req.gateway === gateway && (req.checkout_request_id === ref || req.merchant_request_id === ref || req.id === ref)) {
      return req;
    }
  }
  return null;
}

/**
 * Returns latest payment requests
 */
export function listRecentRequests(limit = 25) {
  return Array.from(paymentRequests.values())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

/**
 * Lists all requests with flexible filtering by gateway, status, search query, and date range
 */
export function listAllRequests({ gateway = 'all', status = 'all', search = '', startDate = '', endDate = '', limit = 100 } = {}) {
  let list = Array.from(paymentRequests.values())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (gateway && gateway !== 'all') {
    list = list.filter(r => r.gateway === gateway.toLowerCase());
  }

  if (status && status !== 'all') {
    list = list.filter(r => {
      const s = (r.status || '').toLowerCase();
      if (status === 'failed') return s === 'failed' || s === 'cancelled' || s === 'expired';
      return s === status.toLowerCase();
    });
  }

  // Filter by start date (inclusive)
  if (startDate && startDate.trim()) {
    const sStr = startDate.trim();
    // Accept YYYY-MM-DD or full ISO
    const startMs = new Date(sStr.includes('T') ? sStr : `${sStr}T00:00:00.000Z`).getTime();
    if (!isNaN(startMs)) {
      list = list.filter(r => new Date(r.created_at).getTime() >= startMs);
    }
  }

  // Filter by end date (inclusive through end of day)
  if (endDate && endDate.trim()) {
    const eStr = endDate.trim();
    const endMs = new Date(eStr.includes('T') ? eStr : `${eStr}T23:59:59.999Z`).getTime();
    if (!isNaN(endMs)) {
      list = list.filter(r => new Date(r.created_at).getTime() <= endMs);
    }
  }

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter(r =>
      (r.receipt_reference && r.receipt_reference.toLowerCase().includes(q)) ||
      (r.checkout_request_id && r.checkout_request_id.toLowerCase().includes(q)) ||
      (r.internal_receipt_no && r.internal_receipt_no.toLowerCase().includes(q)) ||
      (r.phone && r.phone.toLowerCase().includes(q)) ||
      (r.account && r.account.toLowerCase().includes(q)) ||
      (r.gateway && r.gateway.toLowerCase().includes(q)) ||
      (r.metadata && r.metadata.email && r.metadata.email.toLowerCase().includes(q))
    );
  }

  return list.slice(0, limit);
}

/**
 * Computes aggregate summary metrics for the transactions ledger
 */
export function getTransactionStats(targetList = null) {
  const all = targetList || Array.from(paymentRequests.values());
  let successCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let totalVolume = 0;

  all.forEach(r => {
    const s = (r.status || '').toLowerCase();
    if (s === 'success') {
      successCount++;
      totalVolume += (Number(r.amount_paid || r.amount) || 0);
    } else if (s === 'pending') {
      pendingCount++;
    } else {
      failedCount++;
    }
  });

  return {
    totalCount: all.length,
    successCount,
    pendingCount,
    failedCount,
    totalVolume,
    successRate: all.length > 0 ? ((successCount / all.length) * 100).toFixed(1) : '100.0'
  };
}

/**
 * Explicitly links an external payment request to an internal sale receipt
 */
export function linkPaymentToSale(paymentRequestId, receiptNo, saleId = null) {
  let req = paymentRequests.get(paymentRequestId);
  if (!req) {
    req = findRequestByAnyRef(paymentRequestId);
  }
  if (!req) return null;

  req.internal_receipt_no = receiptNo;
  if (saleId) req.internal_sale_id = saleId;
  req.linked_at = new Date().toISOString();
  req.updated_at = new Date().toISOString();

  return req;
}

/**
 * Finds a payment request by any external or internal reference
 */
export function findRequestByAnyRef(ref) {
  if (!ref) return null;
  const q = String(ref).trim().toLowerCase();
  for (const req of paymentRequests.values()) {
    if (
      (req.receipt_reference && req.receipt_reference.toLowerCase() === q) ||
      (req.checkout_request_id && req.checkout_request_id.toLowerCase() === q) ||
      (req.internal_receipt_no && req.internal_receipt_no.toLowerCase() === q) ||
      (req.id && req.id.toLowerCase() === q)
    ) {
      return req;
    }
  }
  return null;
}

/**
 * Gets sanitized gateway configuration
 */
export function getGatewayConfig(gateway) {
  const cfg = gatewayConfigs[gateway];
  if (!cfg) return null;
  // Return safe copy with sensitive secrets masked
  return {
    ...cfg,
    has_secret: Boolean(cfg.consumer_secret || cfg.app_secret || cfg.secret_key || cfg.client_secret),
    has_key: Boolean(cfg.consumer_key || cfg.app_key || cfg.public_key || cfg.client_id)
  };
}

/**
 * Gets internal full config (for server crypto/api execution)
 */
export function getInternalConfig(gateway) {
  return gatewayConfigs[gateway] || null;
}

/**
 * Updates gateway configuration from admin/settings
 */
export function updateGatewayConfig(gateway, updates) {
  if (!gatewayConfigs[gateway]) {
    gatewayConfigs[gateway] = { enabled: true };
  }
  Object.assign(gatewayConfigs[gateway], updates);
  return getGatewayConfig(gateway);
}

/**
 * Returns all public gateway statuses
 */
export function getAllGatewayStatuses() {
  return Object.keys(gatewayConfigs).map(gw => ({
    gateway: gw,
    ...getGatewayConfig(gw)
  }));
}
