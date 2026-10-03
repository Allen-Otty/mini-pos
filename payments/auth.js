// payments/auth.js
//
// SECURITY: the payment simulation and gateway-config endpoints can forge successful
// payments and rewrite live M-Pesa/KCB/Paystack/Airtel credentials. Both used to be
// reachable by anyone on the internet with no login at all. This middleware requires
// a valid Supabase session belonging to a user whose profile.role is 'admin' before
// either endpoint will do anything.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uzwomzkzqrpiumtnniik.supabase.co';
// No embedded fallback key: if this is missing the middleware below refuses every request
// (fails closed) instead of silently authenticating against a key baked into the source.
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!SUPABASE_ANON_KEY) {
  console.error('[payments/auth] SUPABASE_ANON_KEY is not set - all authenticated payment endpoints will return 503 until it is.');
}

/**
 * Validates the bearer token against Supabase Auth, then confirms the matching
 * profiles row has role = 'admin'. Attaches { id, email, business_id } to req.admin
 * on success.
 */
export async function requireBusinessAdmin(req, res, next) {
  return authorize(req, res, next, true);
}

/**
 * Same session validation, but any signed-in member of a business (admin or teller) is
 * allowed. Used for the endpoints a cashier needs at checkout (initiate / status).
 * Attaches { id, email, business_id, role } to req.admin.
 */
export async function requireSession(req, res, next) {
  return authorize(req, res, next, false);
}

async function authorize(req, res, next, adminOnly) {
  try {
    if (!SUPABASE_ANON_KEY) {
      return res.status(503).json({ success: false, error: 'Server auth is not configured (SUPABASE_ANON_KEY missing).' });
    }
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ success: false, error: 'Missing Authorization: Bearer <token> header.' });
    }

    // 1. Validate the token against Supabase Auth and get the underlying user.
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!userResp.ok) {
      return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
    }

    const user = await userResp.json();
    if (!user || !user.id) {
      return res.status(401).json({ success: false, error: 'Invalid session payload.' });
    }

    // 2. Look up the profile row for this user (RLS-protected; we pass the caller's
    //    own token so this can only ever return their own row).
    const profileResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,business_id,full_name`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!profileResp.ok) {
      return res.status(401).json({ success: false, error: 'Could not verify account role.' });
    }

    const rows = await profileResp.json();
    const profile = Array.isArray(rows) ? rows[0] : null;

    if (!profile) {
      return res.status(403).json({ success: false, error: 'No business account is linked to this login.' });
    }
    if (adminOnly && profile.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required for this action.' });
    }

    req.admin = {
      id: user.id,
      email: user.email,
      business_id: profile.business_id,
      role: profile.role,
      full_name: profile.full_name
    };

    next();
  } catch (err) {
    console.error('[Auth Middleware Error]', err);
    res.status(500).json({ success: false, error: 'Authorization check failed.' });
  }
}
