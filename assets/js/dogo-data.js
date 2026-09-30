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
    if (!session) { await toSignIn(); return null; }
    const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (!profile) { await toSignIn(); return null; }
    // Look the business up by the profile's own id (platform admins can see many businesses)
    const { data: business } = await sb.from('businesses').select('*').eq('id', profile.business_id).maybeSingle();
    return { session, profile, business };
  }

  // No valid session: clear the "use new UI" flag (prevents a redirect loop) and show the sign-in screen.
  async function toSignIn() {
    try { localStorage.removeItem('dogo_new_ui_ok'); await sb.auth.signOut(); } catch (e) {}
    location.replace('index.html?signin=1');
  }
  async function logout() {
    try { localStorage.removeItem('dogo_new_ui_ok'); sessionStorage.removeItem('dogo_legacy'); await sb.auth.signOut(); } catch (e) {}
    location.replace('index.html?signin=1');
  }

  function toast(msg) {
    let t = document.getElementById('dogoToast');
    if (!t) { t = document.createElement('div'); t.id = 'dogoToast'; t.className = 'dogo-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // Common page start-up: renders header/nav, enforces login, returns context.
  async function boot(active, opts) {
    opts = opts || {};
    try { sessionStorage.removeItem('dogo_legacy'); } catch (e) {}
    DogoShell.render({ active, businessName: 'Dogo POS', onLogout: logout });
    const ctx = await requireSession();
    if (!ctx) return null;
    const name = ctx.business && ctx.business.name;
    ctx.businessId = ctx.profile && ctx.profile.business_id;
    ctx.isAdmin = !!(ctx.profile && ctx.profile.role === 'admin');
    const rawType = (ctx.business && ctx.business.business_type || '').toLowerCase();
    ctx.isHotelOrRestaurant = rawType.includes('hotel') || rawType.includes('restaurant');
    if (name) {
      DogoShell.render({ active, businessName: name, onLogout: logout, showTables: ctx.isHotelOrRestaurant });
      const sub = document.getElementById('bizName'); if (sub) sub.textContent = name;
    }
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

  // Mirrors PLAN_FEATURES in index.html — kept in sync manually (small, rarely-changed
  // table). This is a friendly pre-check only; the real, unbypassable limit lives in
  // the database (supabase/migrations/20260930_subscription_enforcement.sql), so even
  // if this drifts or a request skips this check entirely, the database still refuses
  // an insert that goes over plan.
  const PLAN_LIMITS = {
    'Free':          { maxUsers: 1,      maxBranches: 1, maxProducts: 5,        name: 'Free (Starter)' },
    'Core':          { maxUsers: 5,      maxBranches: 1, maxProducts: Infinity, name: 'Core POS (1 Branch)' },
    'Core Group':    { maxUsers: 25,     maxBranches: 5, maxProducts: Infinity, name: 'Core Group (Up to 5 Branches)' },
    'Control':       { maxUsers: Infinity, maxBranches: 1, maxProducts: Infinity, name: 'Control POS (1 Branch)' },
    'Control Group': { maxUsers: Infinity, maxBranches: 5, maxProducts: Infinity, name: 'Control Group (Up to 5 Branches)' }
  };
  function planKeyFor(business) {
    const raw = (business && business.subscription_plan) || 'Free';
    if (/control.*group/i.test(raw)) return 'Control Group';
    if (/control/i.test(raw)) return 'Control';
    if (/core.*group/i.test(raw)) return 'Core Group';
    if (/core/i.test(raw)) return 'Core';
    return 'Free';
  }
  function planLimitsFor(business) { const key = planKeyFor(business); return Object.assign({ key }, PLAN_LIMITS[key]); }

  window.DogoData = { sb, kes, esc, requireSession, logout, toast, boot, downloadCSV, planLimitsFor };
})();
