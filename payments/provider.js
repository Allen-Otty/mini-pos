// Shared helpers for talking to real payment providers.

/**
 * Public HTTPS origin of THIS server, e.g. https://pay.example.com
 * Providers POST their results here, so it must be reachable from the internet.
 */
export function publicBaseUrl({ requireHttps = false } = {}) {
  const raw = (process.env.PUBLIC_BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (requireHttps && !/^https:\/\//i.test(raw)) return '';
  return raw;
}

/** Callback URL handed to a provider. The per-payment token makes the URL unguessable. */
export function callbackUrlFor(gateway, request, { production = false } = {}) {
  const base = publicBaseUrl({ requireHttps: production });
  if (!base) {
    throw new Error(
      production
        ? 'PUBLIC_BASE_URL must be set to this server\'s public https:// address before taking live payments (providers send results to it).'
        : 'PUBLIC_BASE_URL is not set - the provider has nowhere to send the payment result.'
    );
  }
  return `${base}/api/payments/callbacks/${gateway}/${request.callback_token}`;
}

/** fetch() with a timeout and a JSON body parse that never throws on non-JSON replies. */
export async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Safaricom-style phone: 2547XXXXXXXX / 2541XXXXXXXX. Returns '' when it is not a valid KE mobile. */
export function toE164Kenya(phone) {
  let p = String(phone || '').replace(/[^\d]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if ((p.startsWith('7') || p.startsWith('1')) && p.length === 9) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : '';
}

/** Tiny in-memory OAuth token cache keyed by name. */
const tokenCache = new Map();
export async function cachedToken(key, fetcher) {
  const hit = tokenCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.token;
  const { token, ttlSeconds } = await fetcher();
  tokenCache.set(key, { token, expiresAt: Date.now() + Math.max(60, (ttlSeconds || 3000) - 120) * 1000 });
  return token;
}
export function clearTokenCache(key) { key ? tokenCache.delete(key) : tokenCache.clear(); }
