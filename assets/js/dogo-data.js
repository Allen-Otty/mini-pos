/* Shared Supabase client + session helpers for every page.
   Only the publishable anon key lives here; RLS enforces access. */
(function () {
  const SUPABASE_URL = 'https://uzwomzkzqrpiumtnniik.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_wt1aY_uj1ZR4z5RqIgDZQw_qYNoCl7D';
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  const kes = n => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Returns { session, profile, business } or redirects to the sign-in page.
  async function requireSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { location.replace('index.html'); return null; }
    const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    const { data: business } = await sb.from('businesses').select('*').limit(1).maybeSingle();
    return { session, profile, business };
  }

  async function logout() { await sb.auth.signOut(); location.replace('index.html'); }

  window.DogoData = { sb, kes, esc, requireSession, logout };
})();
