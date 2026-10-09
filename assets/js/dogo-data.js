/* Shared Supabase client, offline resilience, and session helpers for every page.
   Enables complete offline POS operation: from login to sales, shifts, and auto-sync. */
(function () {
  const SUPABASE_URL = 'https://uzwomzkzqrpiumtnniik.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_wt1aY_uj1ZR4z5RqIgDZQw_qYNoCl7D';
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  const LOCAL_QUEUE_KEY = 'dogopos_offline_queue_v1';
  const LOCAL_SHIFT_QUEUE_KEY = 'dogopos_offline_shift_queue_v1';
  const CACHED_PRODUCTS_KEY = 'dogo_cached_products';
  const CACHED_CUSTOMERS_KEY = 'dogo_cached_customers';
  const ACTIVE_SHIFT_KEY = 'dogo_active_shift';

  const DEFAULT_PRODUCTS = [
    { id: 'off-p1', code: 'PRD-001', name: 'Bamburi Cement 50kg', category: 'Building', price: 780, stock: 85, vat_rate: 0.16, unit: 'bag' },
    { id: 'off-p2', code: 'PRD-002', name: 'Corrugated Iron Sheet 30G 2.5m', category: 'Roofing', price: 920, stock: 40, vat_rate: 0.16, unit: 'piece' },
    { id: 'off-p3', code: 'PRD-003', name: 'Wire Nails 3-inch (1kg)', category: 'Hardware', price: 170, stock: 120, vat_rate: 0.16, unit: 'kg' },
    { id: 'off-p4', code: 'PRD-004', name: 'Crown Super Gloss White Paint 4L', category: 'Paints', price: 2150, stock: 18, vat_rate: 0.16, unit: 'can' },
    { id: 'off-p5', code: 'PRD-005', name: 'PPR Pipe 20mm (3 Meters)', category: 'Plumbing', price: 340, stock: 55, vat_rate: 0.16, unit: 'piece' },
    { id: 'off-p6', code: 'PRD-006', name: 'Premia Wheat Flour 2kg', category: 'Groceries', price: 185, stock: 90, vat_rate: 0, unit: 'packet' },
    { id: 'off-p7', code: 'PRD-007', name: 'White Sugar 1kg', category: 'Groceries', price: 160, stock: 110, vat_rate: 0, unit: 'packet' },
    { id: 'off-p8', code: 'PRD-008', name: 'Fresh Milk 500ml', category: 'Dairy', price: 65, stock: 65, vat_rate: 0, unit: 'pouch' },
    { id: 'off-p9', code: 'PRD-009', name: 'Salit Pure Cooking Oil 1L', category: 'Groceries', price: 290, stock: 45, vat_rate: 0.16, unit: 'bottle' },
    { id: 'off-p10', code: 'PRD-010', name: 'Coca-Cola 500ml PET', category: 'Beverages', price: 80, stock: 75, vat_rate: 0.16, unit: 'bottle' },
    { id: 'off-p11', code: 'PRD-011', name: 'LED Bulb 9W Cool White', category: 'Electrical', price: 150, stock: 60, vat_rate: 0.16, unit: 'piece' },
    { id: 'off-p12', code: 'PRD-012', name: 'Padlock Tri-Circle 50mm Brass', category: 'Hardware', price: 420, stock: 32, vat_rate: 0.16, unit: 'piece' }
  ];

  const kes = n => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Helper with timeout to prevent hanging on flaky connections
  function withTimeout(promise, ms = 2500) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Network timeout')), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
  }

  // Returns { session, profile, business } or redirects to index.html ONLY if never logged in
  async function requireSession() {
    let session = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data?.session;
    } catch (e) {}

    // Check offline cached session
    if (!session) {
      try {
        const raw = localStorage.getItem('dogo_offline_session');
        if (raw) session = JSON.parse(raw);
      } catch (e) {}
    }

    const wasLoggedIn = localStorage.getItem('dogopos_is_logged_in') === 'true';

    // If completely unauthenticated
    if (!session && !wasLoggedIn) {
      location.replace('index.html');
      return null;
    }

    // Try fetching profile from cloud or cache
    let profile = null;
    let business = null;

    if (navigator.onLine && session?.user?.id) {
      try {
        const pRes = await withTimeout(
          sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle(),
          2000
        );
        if (pRes?.data) {
          profile = pRes.data;
          localStorage.setItem('dogo_cached_profile', JSON.stringify(profile));
        }
      } catch (e) {}

      try {
        const bRes = await withTimeout(
          sb.from('businesses').select('*').limit(1).maybeSingle(),
          2000
        );
        if (bRes?.data) {
          business = bRes.data;
          localStorage.setItem('dogo_cached_business', JSON.stringify(business));
        }
      } catch (e) {}
    }

    // Fallback to local storage if offline or queries timed out
    if (!profile) {
      try {
        const rawP = localStorage.getItem('dogo_cached_profile');
        if (rawP) profile = JSON.parse(rawP);
      } catch (e) {}
    }

    if (!business) {
      try {
        const rawB = localStorage.getItem('dogo_cached_business');
        if (rawB) business = JSON.parse(rawB);
      } catch (e) {}
    }

    // Synthesize offline profile if missing so cashiers are NEVER blocked
    if (!profile) {
      const email = session?.user?.email || 'admin@dogopos.local';
      profile = {
        id: session?.user?.id || 'offline-cashier',
        full_name: email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Store Cashier',
        email: email,
        role: 'admin',
        business_id: 'biz-default',
        active: true
      };
      localStorage.setItem('dogo_cached_profile', JSON.stringify(profile));
    }

    if (!business) {
      business = {
        id: profile.business_id || 'biz-default',
        name: 'Dogo POS Store',
        business_type: 'Hardware & Retail',
        location: 'Main Branch',
        theme_color: '#00d26a'
      };
      localStorage.setItem('dogo_cached_business', JSON.stringify(business));
    }

    // Persist current session for future offline launches
    if (session) {
      try { localStorage.setItem('dogo_offline_session', JSON.stringify(session)); } catch (e) {}
    }
    localStorage.setItem('dogopos_is_logged_in', 'true');

    return { session, profile, business, isOffline: !navigator.onLine };
  }

  async function logout() {
    try { await sb.auth.signOut(); } catch (e) {}
    localStorage.removeItem('dogopos_is_logged_in');
    localStorage.removeItem('dogo_offline_session');
    location.replace('index.html');
  }

  function toast(msg) {
    let t = document.getElementById('dogoToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dogoToast';
      t.className = 'dogo-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 3500);
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
      const sub = document.getElementById('bizName');
      if (sub) sub.textContent = name;
    }
    ctx.businessId = ctx.profile && ctx.profile.business_id;
    ctx.isAdmin = !!(ctx.profile && ctx.profile.role === 'admin');
    if (opts.adminOnly && !ctx.isAdmin) {
      const main = document.querySelector('main');
      if (main) {
        main.innerHTML = '<div class="dogo-card"><div class="dogo-card__empty">This page is for the business Admin only.</div></div>';
      }
      return null;
    }

    // Auto-update online/offline state
    updateSyncBadges();
    return ctx;
  }

  // --- Offline Data Helpers ---
  async function getProducts() {
    if (navigator.onLine) {
      try {
        const { data, error } = await withTimeout(sb.from('products').select('*').order('name'), 3000);
        if (!error && data && data.length) {
          localStorage.setItem(CACHED_PRODUCTS_KEY, JSON.stringify(data));
          return data;
        }
      } catch (e) {}
    }
    // Load from local storage
    try {
      const raw = localStorage.getItem(CACHED_PRODUCTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.length) return parsed;
      }
    } catch (e) {}
    // Seed default products into cache
    localStorage.setItem(CACHED_PRODUCTS_KEY, JSON.stringify(DEFAULT_PRODUCTS));
    return DEFAULT_PRODUCTS;
  }

  function saveProductsLocally(productsList) {
    try {
      localStorage.setItem(CACHED_PRODUCTS_KEY, JSON.stringify(productsList));
    } catch (e) {}
  }

  async function getCustomers() {
    if (navigator.onLine) {
      try {
        const { data, error } = await withTimeout(sb.from('customers').select('id,name').order('name'), 2500);
        if (!error && data && data.length) {
          localStorage.setItem(CACHED_CUSTOMERS_KEY, JSON.stringify(data));
          return data;
        }
      } catch (e) {}
    }
    try {
      const raw = localStorage.getItem(CACHED_CUSTOMERS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    const defaults = [{ id: 'walk-in', name: 'Walk-in Retail Customer' }];
    localStorage.setItem(CACHED_CUSTOMERS_KEY, JSON.stringify(defaults));
    return defaults;
  }

  // --- Shift Sessions (Works 100% Offline) ---
  async function getActiveShift(businessId, userId) {
    if (navigator.onLine) {
      try {
        const { data, error } = await withTimeout(
          sb.from('shift_sessions')
            .select('*')
            .eq('business_id', businessId)
            .order('created_at', { ascending: false })
            .limit(10),
          2500
        );
        if (!error && data) {
          const open = data.find(s => s.status === 'OPEN' && s.user_id === userId);
          if (open) {
            localStorage.setItem(ACTIVE_SHIFT_KEY, JSON.stringify(open));
            return open;
          }
        }
      } catch (e) {}
    }
    // Check locally stored shift
    try {
      const raw = localStorage.getItem(ACTIVE_SHIFT_KEY);
      if (raw) {
        const shift = JSON.parse(raw);
        if (shift && shift.status === 'OPEN') return shift;
      }
    } catch (e) {}
    return null;
  }

  function openShiftLocally(businessId, userId, floatVal) {
    const shift = {
      id: crypto.randomUUID ? crypto.randomUUID() : 'shift-' + Date.now(),
      business_id: businessId,
      user_id: userId,
      opening_float: floatVal,
      status: 'OPEN',
      created_at: new Date().toISOString()
    };
    localStorage.setItem(ACTIVE_SHIFT_KEY, JSON.stringify(shift));

    // Queue for sync
    const shiftQueue = getOfflineShiftQueue();
    shiftQueue.push({ type: 'open', shift });
    localStorage.setItem(LOCAL_SHIFT_QUEUE_KEY, JSON.stringify(shiftQueue));

    if (navigator.onLine) {
      sb.from('shift_sessions').insert(shift).catch(() => {});
    }
    updateSyncBadges();
    return shift;
  }

  function closeShiftLocally(shiftId, actualVal, expectedVal, variance, notes) {
    const shiftQueue = getOfflineShiftQueue();
    shiftQueue.push({
      type: 'close',
      shiftId: shiftId,
      expected_cash: expectedVal,
      actual_cash: actualVal,
      cash_variance: variance,
      notes: notes,
      closed_at: new Date().toISOString()
    });
    localStorage.setItem(LOCAL_SHIFT_QUEUE_KEY, JSON.stringify(shiftQueue));
    localStorage.removeItem(ACTIVE_SHIFT_KEY);

    if (navigator.onLine) {
      sb.from('shift_sessions').update({
        status: 'CLOSED',
        closed_at: new Date().toISOString(),
        expected_cash: expectedVal,
        actual_cash: actualVal,
        cash_variance: variance
      }).eq('id', shiftId).catch(() => {});
    }
    updateSyncBadges();
  }

  function getOfflineShiftQueue() {
    try { return JSON.parse(localStorage.getItem(LOCAL_SHIFT_QUEUE_KEY) || '[]'); } catch (e) { return []; }
  }

  // --- Offline Sales Queue (Shared with index.html) ---
  function getOfflineQueue() {
    try { return JSON.parse(localStorage.getItem(LOCAL_QUEUE_KEY) || '[]'); } catch (e) { return []; }
  }

  function queueOfflineSale(saleRecord, lineItems) {
    const queue = getOfflineQueue();
    queue.push({ saleRecord, lineItems });
    localStorage.setItem(LOCAL_QUEUE_KEY, JSON.stringify(queue));

    // Optimistically deduct stock in local products
    try {
      const rawProds = localStorage.getItem(CACHED_PRODUCTS_KEY);
      if (rawProds) {
        const prods = JSON.parse(rawProds);
        lineItems.forEach(li => {
          const p = prods.find(item => item.id === li.product_id || item.code === li.code);
          if (p) p.stock = Math.max(0, Number(p.stock || 0) - Number(li.qty));
        });
        localStorage.setItem(CACHED_PRODUCTS_KEY, JSON.stringify(prods));
      }
    } catch (e) {}

    updateSyncBadges();
  }

  async function syncOfflineSales() {
    if (!navigator.onLine) {
      toast('Still offline — sales will sync automatically when connected.');
      return { ok: false, pending: getOfflineQueue().length };
    }

    // 1. Sync shifts first
    const shiftQueue = getOfflineShiftQueue();
    const remainingShifts = [];
    for (const item of shiftQueue) {
      try {
        if (item.type === 'open') {
          const { error } = await sb.from('shift_sessions').insert(item.shift);
          if (error && !String(error.message).includes('duplicate key')) throw error;
        } else if (item.type === 'close') {
          const { error } = await sb.from('shift_sessions').update({
            status: 'CLOSED',
            closed_at: item.closed_at,
            expected_cash: item.expected_cash,
            actual_cash: item.actual_cash,
            cash_variance: item.cash_variance
          }).eq('id', item.shiftId);
          if (error) throw error;
        }
      } catch (e) {
        remainingShifts.push(item);
      }
    }
    localStorage.setItem(LOCAL_SHIFT_QUEUE_KEY, JSON.stringify(remainingShifts));

    // 2. Sync sales
    const queue = getOfflineQueue();
    if (queue.length === 0) {
      updateSyncBadges();
      return { ok: true, synced: 0, pending: 0 };
    }

    toast(`Syncing ${queue.length} offline sale(s)...`);
    const remainingSales = [];
    let syncedCount = 0;

    for (const entry of queue) {
      const rec = entry.saleRecord;
      const items = entry.lineItems;
      try {
        const { error } = await sb.rpc('process_sale', {
          p_business_id: rec.business_id,
          p_cashier_id: rec.cashier_id,
          p_receipt_no: rec.receipt_no,
          p_customer_id: rec.customer_id || null,
          p_subtotal_excl_vat: Number(rec.subtotal_excl_vat || 0),
          p_vat_total: Number(rec.vat_total || 0),
          p_total: Number(rec.total || 0),
          p_offline_uuid: rec.offline_uuid,
          p_items: items,
          p_payment_method: rec.payment_method || 'cash',
          p_shift_id: rec.shift_id || null,
          p_mpesa_receipt_no: rec.mpesa_receipt_no || null
        });
        if (error && !String(error.message).includes('duplicate') && !String(error.message).includes('already exists')) {
          remainingSales.push(entry);
        } else {
          syncedCount++;
        }
      } catch (err) {
        remainingSales.push(entry);
      }
    }

    localStorage.setItem(LOCAL_QUEUE_KEY, JSON.stringify(remainingSales));
    updateSyncBadges();

    if (remainingSales.length === 0) {
      toast(`✓ All ${syncedCount} offline sale(s) synced successfully!`);
    } else {
      toast(`${remainingSales.length} sale(s) still waiting for server response.`);
    }

    return { ok: remainingSales.length === 0, synced: syncedCount, pending: remainingSales.length };
  }

  function updateSyncBadges() {
    const queueCount = getOfflineQueue().length + getOfflineShiftQueue().length;
    const badge = document.getElementById('dogoSyncPill');
    if (badge) {
      if (queueCount > 0) {
        badge.style.display = 'inline-flex';
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;display:inline-block;margin-right:4px;"></span>🔄 Sync (${queueCount})`;
        badge.title = `${queueCount} offline item(s) pending sync. Click to sync now.`;
      } else if (!navigator.onLine) {
        badge.style.display = 'inline-flex';
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;display:inline-block;margin-right:4px;"></span>Offline`;
        badge.title = 'Offline Mode Active';
      } else {
        badge.style.display = 'inline-flex';
        badge.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#00d26a;display:inline-block;margin-right:4px;"></span>Online`;
        badge.title = 'Online & Synced';
      }
    }
  }

  // Network listeners for seamless auto-sync
  window.addEventListener('online', () => {
    toast('Back online! Syncing data...');
    updateSyncBadges();
    syncOfflineSales();
  });

  window.addEventListener('offline', () => {
    toast('Operating in Offline Mode — sales will save locally.');
    updateSyncBadges();
  });

  // Periodic background sync attempt every 30 seconds if online
  setInterval(() => {
    if (navigator.onLine && (getOfflineQueue().length > 0 || getOfflineShiftQueue().length > 0)) {
      syncOfflineSales();
    }
  }, 30000);

  // Register service worker automatically
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js')
        .then(reg => {
          reg.onupdatefound = () => {
            const installing = reg.installing;
            if (installing) {
              installing.onstatechange = () => {
                if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                  // Service worker updated
                }
              };
            }
          };
        })
        .catch(err => console.warn('SW register error:', err));
    });
  }

  // Download rows as a CSV file
  function downloadCSV(filename, rows) {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const blob = new Blob(['\ufeff' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  window.DogoData = {
    sb,
    kes,
    esc,
    requireSession,
    logout,
    toast,
    boot,
    getProducts,
    saveProductsLocally,
    getCustomers,
    getActiveShift,
    openShiftLocally,
    closeShiftLocally,
    queueOfflineSale,
    getOfflineQueue,
    syncOfflineSales,
    updateSyncBadges,
    downloadCSV
  };
})();
