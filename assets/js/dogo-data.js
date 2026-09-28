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

  function toast(msg) {
    let t = document.getElementById('dogoToast');
    if (!t) { t = document.createElement('div'); t.id = 'dogoToast'; t.className = 'dogo-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // Common page start-up: renders header/nav, enforces login, returns context.
  async function boot(active, opts) {
    opts = opts || {};
    DogoShell.render({ active, businessName: 'Dogo POS', onLogout: logout });
    const ctx = await requireSession();
    if (!ctx) return null;
    const name = ctx.business && ctx.business.name;
    if (name) {
      DogoShell.render({ active, businessName: name, onLogout: logout });
      const sub = document.getElementById('bizName'); if (sub) sub.textContent = name;
    }
    ctx.businessId = ctx.profile && ctx.profile.business_id;
    ctx.isAdmin = !!(ctx.profile && ctx.profile.role === 'admin');
    if (opts.adminOnly && !ctx.isAdmin) {
      document.querySelector('main').innerHTML = '<div class="dogo-card"><div class="dogo-card__empty">This page is for the business Admin only.</div></div>';
      return null;
    }
    return ctx;
  }

  // Download rows (array of arrays) as a CSV file.
  function downloadCSV(filename, rows) {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const blob = new Blob(['\ufeff' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  window.DogoData = { sb, kes, esc, requireSession, logout, toast, boot, downloadCSV };
})();
