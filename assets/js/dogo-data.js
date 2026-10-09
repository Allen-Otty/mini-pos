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

  /* ---- Offline support -------------------------------------------------
     The last good { profile, business } is remembered per signed-in user so the
     app can reopen with no connection. It only ever restores data that came from
     a real earlier sign-in; it never invents a user. */
  const CTX_KEY = 'dogo_ctx_v1';
  const isOnline = () => navigator.onLine !== false;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const isNetworkErr = e => !!e && !e.code && (!e.status || e.status === 0 || /fetch|network|load failed/i.test(String(e.message || e)));

  function cachedResult(c) {
    return { session: { user: { id: c.userId }, access_token: null, offline: true }, profile: c.profile, business: c.business, offline: true };
  }

  // Returns { session, profile, business } or redirects to the sign-in page.
  // With no connection it falls back to the cached sign-in (result.offline === true).
  async function requireSession() {
    // After any logout the device stays "locked" until the password is entered again (online or offline).
    if (localStorage.getItem('dogo_locked') === '1') { await toSignIn(); return null; }
    const cached = lsGet(CTX_KEY, null);
    let session = null, sessErr = null;
    try { const r = await sb.auth.getSession(); session = r.data && r.data.session; sessErr = r.error; } catch (e) { sessErr = e; }
    if (!session) {
      if (cached && (!isOnline() || isNetworkErr(sessErr))) return cachedResult(cached);
      await toSignIn(); return null;
    }
    try {
      const { data: profile, error: pErr } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      if (pErr && cached && cached.userId === session.user.id && isNetworkErr(pErr)) return cachedResult(cached);
      if (!profile) { await toSignIn(); return null; }
      // Look the business up by the profile's own id (platform admins can see many businesses)
      const { data: business } = await sb.from('businesses').select('*').eq('id', profile.business_id).maybeSingle();
      lsSet(CTX_KEY, { userId: session.user.id, profile, business, savedAt: Date.now() });
      return { session, profile, business };
    } catch (e) {
      if (cached && cached.userId === session.user.id) return cachedResult(cached);
      throw e;
    }
  }

  // No valid session: clear the "use new UI" flag (prevents a redirect loop) and show the sign-in screen.
  async function toSignIn() {
    if (!isOnline()) { location.replace('index.html?signin=1'); return; } // offline: keep the cached sign-in intact
    try { localStorage.removeItem('dogo_new_ui_ok'); await sb.auth.signOut(); } catch (e) {}
    location.replace('index.html?signin=1');
  }
  async function logout() {
    try {
      localStorage.setItem('dogo_locked', '1');                // password required again, even offline
      localStorage.removeItem('dogo_new_ui_ok'); sessionStorage.removeItem('dogo_legacy');
      if (isOnline()) await sb.auth.signOut();                 // offline: keep the session so unsynced sales can sync after the next sign-in
    } catch (e) {}
    location.replace('index.html?signin=1');
  }
  /* (cached sign-in details are kept after logout so the same user can sign back in offline;
     they are only ever restored after the password check) */

  function toast(msg) {
    let t = document.getElementById('dogoToast');
    if (!t) { t = document.createElement('div'); t.id = 'dogoToast'; t.className = 'dogo-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200);
  }


  /* ---- Offline sales queue ---------------------------------------------
     Sales rung up with no connection are kept on the device (per user) and sent
     through the same process_sale RPC when the connection returns. process_sale is
     idempotent on offline_uuid, so a retry can never record a sale twice.
     Sales rejected by the server (e.g. insufficient stock) move to a "failed" list
     instead of retrying forever. Note: the sale's date on the server is the sync
     time, because process_sale has no date parameter. */
  const Offline = (function () {
    const k = (n, uid) => 'dogo_off_' + n + '_' + uid;
    const queue = uid => lsGet(k('sales', uid), []);
    const failed = uid => lsGet(k('failed', uid), []);
    const saveQueue = (uid, q) => lsSet(k('sales', uid), q);
    const saveFailed = (uid, q) => lsSet(k('failed', uid), q);
    const shiftQ = uid => lsGet(k('shifts', uid), []);
    const saveShiftQ = (uid, q) => lsSet(k('shifts', uid), q);
    let syncing = false, lastError = '';

    function enqueueShift(uid, row) { const q = shiftQ(uid); q.push(row); return saveShiftQ(uid, q); }
    function enqueueSale(uid, entry) { const q = queue(uid); q.push(entry); return saveQueue(uid, q); }

    async function syncSales(ctx) {
      const uid = ctx && ctx.profile && ctx.profile.id;
      const pendingCount = () => (uid ? queue(uid).length : 0);
      if (!uid || syncing || !isOnline()) return { synced: 0, failed: 0, remaining: pendingCount() };
      // an offline-restored page may hold an expired token: try to refresh it before giving up
      let { data: { session } } = await sb.auth.getSession();
      if (!session) { try { const r = await sb.auth.refreshSession(); session = r.data && r.data.session; } catch (e) {} }
      if (!session) { lastError = 'Sign in again (while online) to sync.'; refreshBar(); return { synced: 0, failed: 0, remaining: pendingCount() }; }
      syncing = true; lastError = '';
      let synced = 0, rejected = 0;
      try {
        // 1) shifts opened offline must exist on the server before the sales that point at them
        let sq = shiftQ(uid);
        while (sq.length) {
          const { error } = await sb.from('shift_sessions').insert(sq[0]);
          if (error && error.code !== '23505') {            // 23505 = already there from an earlier try: fine
            lastError = isNetworkErr(error) ? 'Connection dropped - will retry.' : 'Could not sync the shift: ' + error.message;
            break;
          }
          sq = sq.slice(1); saveShiftQ(uid, sq);
        }
        // 2) sales
        let q = sq.length ? [] : queue(uid);
        while (q.length) {
          const e = q[0];
          const { count } = await sb.from('sales').select('id', { count: 'exact', head: true });
          const receipt = 'RC-' + String((count || 0) + 1).padStart(4, '0');
          const { error } = await sb.rpc('process_sale', Object.assign({}, e.args, { p_receipt_no: receipt }));
          if (error) {
            if (isNetworkErr(error) || !isOnline()) { lastError = 'Connection dropped - will retry.'; break; }
            const f = failed(uid); f.push({ entry: e, reason: error.message, at: Date.now() }); saveFailed(uid, f);
            lastError = 'Server rejected a sale: ' + error.message;
            rejected++;
          } else synced++;
          q = q.slice(1); saveQueue(uid, q);
        }
      } catch (err) { lastError = 'Sync error: ' + (err && err.message || err); }
      finally { syncing = false; }
      const remaining = queue(uid).length;
      window.dispatchEvent(new CustomEvent('dogo:synced', { detail: { synced, rejected, remaining } }));
      refreshBar();
      return { synced, failed: rejected, remaining };
    }

    // Thin status strip: shows when offline and how many sales are waiting to sync.
    let barCtx = null, bar = null;
    function refreshBar() {
      if (!barCtx) return;
      const uid = barCtx.profile.id, n = queue(uid).length, bad = failed(uid).length, off = !isOnline();
      const sh = shiftQ(uid).length;
      if (!off && !n && !bad && !sh) { if (bar) bar.style.display = 'none'; return; }
      if (!bar) {
        bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:9px 14px;font:600 13px system-ui,sans-serif;text-align:center;cursor:pointer;padding-bottom:calc(9px + env(safe-area-inset-bottom,0px))';
        bar.onclick = () => { if (!isOnline()) return toast('Still offline - it will sync when you reconnect.');
          syncSales(barCtx).then(r => toast(r.remaining ? (lastError || (r.remaining + ' sale(s) still waiting.')) : 'All sales synced.')); };
        document.body.appendChild(bar);
      }
      bar.style.display = 'block';
      bar.style.background = off ? '#fef3c7' : (bad ? '#fee2e2' : '#0f172a');
      bar.style.color = off ? '#92400e' : (bad ? '#991b1b' : '#facc15');
      bar.textContent = (off ? 'Offline — sales save on this device and sync when you reconnect.' : '')
        + (sh && !n ? (off ? ' ' : '') + 'Shift waiting to sync' + (off ? '.' : ' - tap to sync now.') : '')
        + (n ? (off ? ' ' : '') + n + ' sale' + (n === 1 ? '' : 's') + ' waiting to sync' + (off ? '.' : ' — tap to sync now.') : '')
        + (!off && lastError && (n || sh) ? ' ' + lastError : '')
        + (bad ? ' ' + bad + ' offline sale' + (bad === 1 ? ' was' : 's were') + ' rejected by the server (see Reports/ask Admin).' : '');
    }
    function watch(ctx) {
      barCtx = ctx; refreshBar();
      window.addEventListener('online', () => { refreshBar(); syncSales(ctx); });
      window.addEventListener('offline', refreshBar);
      if (isOnline()) syncSales(ctx);
    }
    return { isOnline, isNetworkErr, lsGet, lsSet, queue, failed, enqueueSale, enqueueShift, shiftQueue: shiftQ, syncSales, watch, refreshBar,
      // cached read-only data (products, customers, current shift...) so pages can open offline
      cacheGet: (name, uid) => lsGet(k('cache_' + name, uid), null),
      cacheSet: (name, uid, v) => lsSet(k('cache_' + name, uid), v) };
  })();

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
    Offline.watch(ctx);
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
  // Admin-edited limits (plan_definitions table). Cached copy applies instantly; a background
  // fetch refreshes it for next time. Falls back to the table above if never loaded.
  function applyPlanCatalog(rows) {
    (rows || []).forEach(r => {
      if (!PLAN_LIMITS[r.plan]) return;
      PLAN_LIMITS[r.plan] = {
        maxUsers: r.max_tellers === null ? Infinity : r.max_tellers + 1,
        maxBranches: r.max_branches === null ? Infinity : r.max_branches,
        maxProducts: r.max_products === null ? Infinity : r.max_products,
        name: r.display_name
      };
    });
  }
  try { applyPlanCatalog(JSON.parse(localStorage.getItem('dogo_plan_defs_v2') || 'null')); } catch (e) {}
  try {
    fetch(SUPABASE_URL + '/rest/v1/plan_definitions?select=*&order=sort_order', { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } })
      .then(r => r.ok ? r.json() : null)
      .then(rows => { if (Array.isArray(rows) && rows.length) { localStorage.setItem('dogo_plan_defs_v2', JSON.stringify(rows)); applyPlanCatalog(rows); } })
      .catch(() => {});
  } catch (e) {}
  function planKeyFor(business) {
    const raw = (business && business.subscription_plan) || 'Free';
    if (/control.*group/i.test(raw)) return 'Control Group';
    if (/control/i.test(raw)) return 'Control';
    if (/core.*group/i.test(raw)) return 'Core Group';
    if (/core/i.test(raw)) return 'Core';
    return 'Free';
  }
  function planLimitsFor(business) { const key = planKeyFor(business); return Object.assign({ key }, PLAN_LIMITS[key]); }

  // The Express payments API requires a signed-in session. Pages that call it add these headers.
  async function apiAuthHeaders(extra) {
    const { data: { session } } = await sb.auth.getSession();
    const h = Object.assign({}, extra || {});
    if (session && session.access_token) h.Authorization = 'Bearer ' + session.access_token;
    return h;
  }

  window.DogoData = { Offline, isOnline, sb, kes, esc, requireSession, logout, toast, boot, downloadCSV, planLimitsFor, apiAuthHeaders };
})();
