/* Dogo POS — plan catalog loader.
   Prices, limits and feature lists are edited in the Admin Console and stored in the
   plan_catalog table (supabase/migrations/20261009_plan_catalog.sql). This file loads them
   (works signed-out too) and patches the page's built-in defaults, so if the table is missing
   or the network is down, the pages simply keep showing the defaults they ship with. */
(function () {
  const URL = 'https://uzwomzkzqrpiumtnniik.supabase.co';
  const KEY = 'sb_publishable_wt1aY_uj1ZR4z5RqIgDZQw_qYNoCl7D';
  const CACHE = 'dogo_plan_catalog_v1';
  let rows = null;

  const fmt = n => Number(n || 0).toLocaleString('en-KE');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const richText = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const lim = v => (v === null || v === undefined) ? Infinity : Number(v);

  async function load() {
    if (rows) return rows;
    try {
      const r = await fetch(URL + '/rest/v1/plan_catalog?select=*&order=sort', {
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (Array.isArray(data) && data.length) {
        rows = data;
        try { localStorage.setItem(CACHE, JSON.stringify(rows)); } catch (e) {}
        return rows;
      }
    } catch (e) { console.warn('plan_catalog unavailable, using built-in defaults:', e.message); }
    try { rows = JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (e) { rows = null; }
    return rows || [];
  }

  const row = plan => (rows || []).find(r => r.plan === plan);
  const saveText = r => 'KES ' + fmt(Math.max(0, r.monthly_price * 12 - r.yearly_price));

  // Limits in the same shape dogo-data.js / index.html already use.
  function limitsFor(plan) {
    const r = row(plan); if (!r) return null;
    return {
      maxUsers: r.max_tellers === null ? Infinity : r.max_tellers + 1,
      maxBranches: lim(r.max_branches), maxProducts: lim(r.max_products), name: r.display_name
    };
  }

  // Patch index.html's PLAN_FEATURES (client-side checks).
  function applyToPlanFeatures(PF) {
    (rows || []).forEach(r => {
      const t = PF[r.plan]; if (!t) return;
      t.priceMonth = Number(r.monthly_price); t.priceYear = Number(r.yearly_price);
      t.maxUsers = r.max_tellers === null ? Infinity : r.max_tellers + 1;
      t.maxBranches = lim(r.max_branches); t.maxProducts = lim(r.max_products);
      Object.keys(r.flags || {}).forEach(k => { t[k] = !!r.flags[k]; });
    });
  }

  // Patch index.html's upgrade-screen table.
  function applyToPosfiti(P) {
    const map = { 'Core': ['core', '1'], 'Core Group': ['core', '5'], 'Control': ['control', '1'], 'Control Group': ['control', '5'] };
    (rows || []).forEach(r => {
      const m = map[r.plan]; if (!m || !P[m[0]] || !P[m[0]][m[1]]) return;
      const c = P[m[0]][m[1]];
      c.monthly.price = Number(r.monthly_price); c.yearly.price = Number(r.yearly_price);
      c.yearly.saveBadge = r.yearly_price > 0 ? 'Save ' + saveText(r) : '';
      if (r.features && r.features.length) c.features = r.features.map(f => f.replace(/\*\*/g, '')).slice(0, 8);
    });
  }

  // Patch the public pricing cards + signup plan picker.
  const IDS = {
    'Core': 'core', 'Core Group': 'coreGroup', 'Control': 'control', 'Control Group': 'controlGroup'
  };
  function applyToLanding() {
    (rows || []).forEach(r => {
      const base = IDS[r.plan];
      if (base) { const a = document.getElementById(base + 'PriceAmount'); if (a) a.textContent = 'KES ' + fmt(r.monthly_price); }
      const ul = document.querySelector('[data-plan-features="' + r.plan + '"]');
      if (ul && r.features && r.features.length) {
        ul.innerHTML = r.features.map(f => '<li><i class="fa-solid fa-circle-check"></i> ' + richText(f) + '</li>').join('');
      }
      const tag = document.querySelector('[data-plan-tagline="' + r.plan + '"]');
      if (tag && r.tagline) tag.textContent = r.tagline;
      const optId = { 'Free': 'suPlanOptFree', 'Core': 'suPlanOptCore', 'Control': 'suPlanOptControl', 'Core Group': 'suPlanOptCoreGroup', 'Control Group': 'suPlanOptControlGroup' }[r.plan];
      const sub = optId && document.querySelector('#' + optId + ' .su-plan-sub');
      if (sub) sub.textContent = sub.textContent.replace(/KES [\d,]+\/mo/, 'KES ' + fmt(r.monthly_price) + '/mo');
    });
  }

  // Monthly / yearly toggle data for setBillingCycle().
  function tiers() {
    return Object.keys(IDS).map(p => {
      const r = row(p); if (!r) return null;
      return { amt: IDS[p] + 'PriceAmount', per: IDS[p] + 'PricePeriod',
               m: 'KES ' + fmt(r.monthly_price), y: 'KES ' + fmt(r.yearly_price), save: saveText(r) };
    }).filter(Boolean);
  }

  window.DogoPlanCatalog = { load, row, limitsFor, applyToPlanFeatures, applyToPosfiti, applyToLanding, tiers,
    get rows() { return rows || []; }, price: (p, cycle) => { const r = row(p); return r ? Number(cycle === 'yearly' ? r.yearly_price : r.monthly_price) : null; } };
})();
