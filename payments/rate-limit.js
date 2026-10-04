// Lightweight in-process rate limiter (fixed window). Chosen over a dependency
// so the payment server stays a zero-extra-deps deploy; this is not distributed
// — a multi-instance deployment should swap in a shared-store limiter.
const buckets = new Map(); // key -> { count, windowStart, windowMs }

// periodic cleanup so long-running processes don't grow the map forever
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now - v.windowStart > v.windowMs * 2) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

/**
 * Returns Express middleware allowing `max` requests per `windowMs` per client key.
 * `keyFn` decides what identifies the caller (IP by default, but business-scoped
 * limits can use req.admin.business_id).
 */
export function rateLimit({ max, windowMs, keyFn, message }) {
  return (req, res, next) => {
    let key;
    try { key = keyFn ? keyFn(req) : clientIp(req); } catch (e) { key = clientIp(req); }
    const bucketKey = (req.baseUrl || req.route?.path || req.path || '') + '::' + key;
    const now = Date.now();
    let bucket = buckets.get(bucketKey);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { count: 0, windowStart: now, windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, error: message || 'Too many requests. Try again shortly.' });
    }
    next();
  };
}

export function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket?.remoteAddress || 'unknown';
}
