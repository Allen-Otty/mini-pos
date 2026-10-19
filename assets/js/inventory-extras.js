/* Dogo POS — inventory control extras (Stage 1).
   Adds to inventory.html: the real stock movement history (kardex) in the Inventory Ledger tab, plus
   Stock Counts, Lots & Expiry (with serials and tracking switches) and Cost History tabs.
   Needs supabase/migrations/20261018_purchasing_inventory_control.sql; without it every tab shows a
   plain "run the migration" notice and the rest of the page keeps working. */
(function () {
  'use strict';
  var MISSING = 'This needs the database update 20261018_purchasing_inventory_control.sql. Ask your admin to run it in Supabase, then reload.';
  var TYPE_LABEL = { opening: 'Opening stock', purchase: 'Purchase', sale: 'Sale', adjustment: 'Adjustment', count: 'Stock count', return: 'Return' };
  var TYPE_COLOR = { opening: '#475569', purchase: '#047857', sale: '#1d4ed8', adjustment: '#b45309', count: '#7c3aed', return: '#0f766e' };
  var sb, ctx, esc, ksh, toast, getProducts, canManage = false;
  var state = { countId: null, items: [], countRow: null };

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 3 }); }
  function when(s) { return s ? new Date(s).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
  function day(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-KE', { dateStyle: 'medium' }) : '—'; }
  function missing(e) { return !!e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST202' || /does not exist|schema cache|Could not find/i.test(e.message || '')); }
  function notice(el, msg) { el.innerHTML = '<div class="dogo-card" style="padding:22px;color:var(--dogo-text-muted);">' + esc(msg) + '</div>'; }
  function prodOptions(first) {
    return '<option value="">' + esc(first) + '</option>' + getProducts().map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.code ? ' (' + esc(p.code) + ')' : '') + '</option>';
    }).join('');
  }
  function csv(name, rows) {
    var out = rows.map(function (r) { return r.map(function (c) { return '"' + String(c === null || c === undefined ? '' : c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function head(title, sub) {
    return '<div style="margin-bottom:16px;"><h1 style="font-size:24px;font-weight:800;margin:0 0 4px;color:var(--dogo-ink);">' + title +
      '</h1><p style="font-size:14px;color:var(--dogo-text-muted);margin:0;">' + sub + '</p></div>';
  }
  function badge(text, bg, fg) { return '<span class="dogo-badge" style="background:' + bg + ';color:' + fg + ';">' + text + '</span>'; }

  /* ------------------------------------------------------------------ init + tabs */
  function init(o) {
    sb = o.sb; ctx = o.ctx; esc = o.esc; ksh = o.ksh; toast = o.toast; getProducts = o.getProducts;
    canManage = !!(ctx && ctx.profile && (ctx.profile.role === 'admin' || ctx.profile.role === 'manager'));
    var bar = document.querySelector('.dogo-subnav-bar'), after = $('viewCogs');
    if (!bar || !after) return;
    [['counts', 'Stock Counts'], ['lots', 'Lots & Expiry'], ['costs', 'Cost History']].forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'dogo-subnav-btn'; b.setAttribute('data-inv-tab', t[0]); b.innerHTML = '<span>' + t[1] + '</span>';
      b.onclick = function () { window.__invSwitchTab(t[0]); };
      bar.appendChild(b);
      var v = document.createElement('div');
      v.setAttribute('data-inv-view', t[0]); v.style.display = 'none'; v.id = 'view_' + t[0];
      after.parentNode.appendChild(v);
    });
  }

  function onTab(t) {
    if (t === 'ledger') renderKardex();
    else if (t === 'counts') renderCounts();
    else if (t === 'lots') renderLots();
    else if (t === 'costs') renderCosts();
  }

  /* ------------------------------------------------------------------ kardex (Inventory Ledger tab) */
  function renderKardex() {
    var m = $('kardexMount'); if (!m) return;
    if (!m.getAttribute('data-ready')) {
      m.setAttribute('data-ready', '1');
      m.innerHTML =
        '<section class="dogo-card" style="padding:16px 20px;margin-bottom:12px;"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
        '<select class="dogo-select" id="kdProduct" style="min-width:200px;flex:1;">' + prodOptions('All products') + '</select>' +
        '<select class="dogo-select" id="kdType"><option value="">All movements</option>' + Object.keys(TYPE_LABEL).map(function (k) { return '<option value="' + k + '">' + TYPE_LABEL[k] + '</option>'; }).join('') + '</select>' +
        '<input class="dogo-input" id="kdFrom" type="date" title="From"><input class="dogo-input" id="kdTo" type="date" title="To">' +
        '<button class="dogo-btn dogo-btn--outline" id="kdCsv">Export CSV</button></div></section>' +
        '<section class="dogo-card" style="padding:20px;"><div class="dogo-table-wrap"><table class="dogo-table"><thead><tr>' +
        '<th>Date</th><th>Product</th><th>Type</th><th style="text-align:right;">Change</th><th style="text-align:right;">Balance</th><th>Details</th></tr></thead>' +
        '<tbody id="kdRows"></tbody></table></div><div id="kdInfo" style="font-size:12.5px;color:var(--dogo-text-muted);margin-top:10px;"></div></section>';
      ['kdProduct', 'kdType', 'kdFrom', 'kdTo'].forEach(function (id) { $(id).onchange = loadKardex; });
      $('kdCsv').onclick = function () {
        var rows = (window.__kardexRows || []).map(function (r) {
          return [r.created_at, r.products ? r.products.name : '', TYPE_LABEL[r.type] || r.type, r.qty_change, r.balance_after, kdDetail(r)];
        });
        csv('stock_movements.csv', [['Date', 'Product', 'Type', 'Change', 'Balance', 'Details']].concat(rows));
      };
    }
    loadKardex();
  }
  function kdDetail(r) {
    if (r.note) return r.note;
    if (r.type === 'sale' && r.ref_id) return 'Sale ' + String(r.ref_id).slice(0, 8);
    if (r.type === 'count') return 'Stock count';
    if (r.ref_id) return String(r.ref_type || '') + ' ' + String(r.ref_id).slice(0, 8);
    return '';
  }
  async function loadKardex() {
    var rows = $('kdRows'); rows.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--dogo-text-muted);">Loading…</td></tr>';
    var q = sb.from('stock_movements').select('id,created_at,type,qty_change,balance_after,unit_cost,ref_type,ref_id,note,products(name,code)').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(500);
    if ($('kdProduct').value) q = q.eq('product_id', $('kdProduct').value);
    if ($('kdType').value) q = q.eq('type', $('kdType').value);
    if ($('kdFrom').value) q = q.gte('created_at', new Date($('kdFrom').value + 'T00:00:00').toISOString());
    if ($('kdTo').value) q = q.lt('created_at', new Date(new Date($('kdTo').value + 'T00:00:00').getTime() + 86400000).toISOString());
    var r = await q;
    if (r.error) { rows.innerHTML = '<tr><td colspan="6" style="padding:24px;color:var(--dogo-text-muted);">' + esc(missing(r.error) ? MISSING : 'Could not load: ' + r.error.message) + '</td></tr>'; return; }
    window.__kardexRows = r.data || [];
    if (!r.data.length) { rows.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:36px;color:var(--dogo-text-muted);">No stock movements yet. They are recorded from now on: sales, purchases, counts and stock edits.</td></tr>'; $('kdInfo').textContent = ''; return; }
    rows.innerHTML = r.data.map(function (m) {
      var up = Number(m.qty_change) > 0;
      return '<tr><td style="white-space:nowrap;">' + esc(when(m.created_at)) + '</td><td><strong>' + esc(m.products ? m.products.name : '—') + '</strong></td><td>' +
        badge(esc(TYPE_LABEL[m.type] || m.type), '#f1f5f9', TYPE_COLOR[m.type] || '#334155') + '</td>' +
        '<td style="text-align:right;font-weight:700;color:' + (up ? '#047857' : '#b91c1c') + ';">' + (up ? '+' : '') + fmt(m.qty_change) + '</td>' +
        '<td style="text-align:right;">' + (m.balance_after === null ? '—' : fmt(m.balance_after)) + '</td><td>' + esc(kdDetail(m)) + '</td></tr>';
    }).join('');
    $('kdInfo').textContent = 'Showing the latest ' + r.data.length + ' movement' + (r.data.length === 1 ? '' : 's') + (r.data.length === 500 ? ' (narrow the filters to see older ones)' : '') + '.';
  }

  /* ------------------------------------------------------------------ stock counts */
  async function renderCounts() {
    var v = $('view_counts'); if (!v) return;
    if (state.countId) return renderCountDetail();
    v.innerHTML = head('Stock Counts', 'Count what is really on the shelf and compare it with the system.') + '<div id="cntBody">Loading…</div>';
    var r = await sb.from('stock_counts').select('id,name,status,created_at,finalized_at').order('created_at', { ascending: false }).limit(50);
    var body = $('cntBody');
    if (r.error) return notice(body, missing(r.error) ? MISSING : 'Could not load: ' + r.error.message);
    var list = r.data || [];
    body.innerHTML = (canManage ? '<div style="margin-bottom:12px;"><button class="dogo-btn dogo-btn--primary" id="cntNew">+ New stock count</button></div>' : '<div style="margin-bottom:12px;font-size:13px;color:var(--dogo-text-muted);">An admin or manager starts and finalizes counts. You can enter counted quantities.</div>') +
      '<section class="dogo-card" style="padding:20px;"><div class="dogo-table-wrap"><table class="dogo-table"><thead><tr><th>Name</th><th>Status</th><th>Started</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map(function (c) {
        var st = c.status === 'open' ? badge('Open', '#fef3c7', '#92400e') : c.status === 'finalized' ? badge('Finalized', '#dcfce7', '#166534') : badge('Cancelled', '#f1f5f9', '#475569');
        return '<tr><td><strong>' + esc(c.name) + '</strong></td><td>' + st + '</td><td>' + esc(when(c.created_at)) + '</td><td><button class="dogo-btn dogo-btn--outline dogo-btn--sm" data-open-count="' + esc(c.id) + '">' + (c.status === 'open' ? 'Continue' : 'View') + '</button></td></tr>';
      }).join('') : '<tr><td colspan="4" style="text-align:center;padding:36px;color:var(--dogo-text-muted);">No counts yet.</td></tr>') + '</tbody></table></div></section>';
    if ($('cntNew')) $('cntNew').onclick = startCount;
    body.onclick = function (e) {
      var id = e.target.getAttribute && e.target.getAttribute('data-open-count');
      if (id) { state.countId = id; renderCountDetail(); }
    };
  }
  async function startCount() {
    var name = prompt('Name this count', 'Stock count ' + new Date().toISOString().slice(0, 10));
    if (name === null) return;
    var r = await sb.rpc('start_stock_count', { p_business_id: ctx.businessId, p_name: name, p_product_ids: null, p_created_by: ctx.profile ? ctx.profile.id : null });
    if (r.error) return toast(missing(r.error) ? MISSING : 'Could not start the count: ' + r.error.message);
    state.countId = r.data; renderCountDetail();
  }
  async function renderCountDetail() {
    var v = $('view_counts');
    v.innerHTML = '<div style="margin-bottom:10px;"><button class="dogo-btn dogo-btn--outline dogo-btn--sm" id="cntBack">&larr; All counts</button></div><div id="cntDetail">Loading…</div>';
    $('cntBack').onclick = function () { state.countId = null; renderCounts(); };
    var c = await sb.from('stock_counts').select('*').eq('id', state.countId).maybeSingle();
    if (c.error || !c.data) { state.countId = null; return notice($('cntDetail'), 'Could not open this count.'); }
    state.countRow = c.data;
    var items = [], from = 0;
    for (;;) {
      var r = await sb.from('stock_count_items').select('id,product_id,product_name,system_qty,counted_qty').eq('count_id', state.countId).order('product_name').range(from, from + 999);
      if (r.error) return notice($('cntDetail'), 'Could not load items: ' + r.error.message);
      items = items.concat(r.data || []); if ((r.data || []).length < 1000) break; from += 1000;
    }
    state.items = items; drawCount();
  }
  function costOf(pid) { var p = getProducts().filter(function (x) { return x.id === pid; })[0]; return p && p.cost !== null && p.cost !== undefined && p.cost !== '' ? Number(p.cost) : null; }
  function drawCount() {
    var c = state.countRow, open = c.status === 'open', el = $('cntDetail'), q = ($('cntSearch') ? $('cntSearch').value : '').trim().toLowerCase();
    var counted = 0, short = 0, over = 0, value = 0;
    state.items.forEach(function (i) {
      if (i.counted_qty === null || i.counted_qty === undefined) return;
      counted++; var d = Number(i.counted_qty) - Number(i.system_qty);
      if (d < 0) short += d; else over += d;
      var cst = costOf(i.product_id); if (cst !== null) value += d * cst;
    });
    var shown = state.items.filter(function (i) { return !q || String(i.product_name || '').toLowerCase().indexOf(q) >= 0; });
    var wasFocused = document.activeElement && document.activeElement.id === 'cntSearch';
    el.innerHTML =
      '<h1 style="font-size:22px;font-weight:800;margin:0 0 4px;">' + esc(c.name) + '</h1>' +
      '<p style="margin:0 0 12px;font-size:13px;color:var(--dogo-text-muted);">' + (open ? 'Open' : c.status === 'finalized' ? 'Finalized ' + when(c.finalized_at) : 'Cancelled') + ' · system quantities were captured when the count started</p>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px;">' +
      kpi('Counted', counted + ' / ' + state.items.length) + kpi('Short (units)', fmt(short), short < 0 ? '#b91c1c' : null) + kpi('Over (units)', fmt(over), over > 0 ? '#047857' : null) + kpi('Value impact', ksh(value), value < 0 ? '#b91c1c' : null) + '</div>' +
      '<section class="dogo-card" style="padding:16px 20px;"><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center;">' +
      '<input class="dogo-input" id="cntSearch" placeholder="Search product…" value="' + esc(q) + '" style="flex:1;min-width:180px;">' +
      '<button class="dogo-btn dogo-btn--outline" id="cntCsv">Export CSV</button>' +
      (open && canManage ? '<button class="dogo-btn dogo-btn--primary" id="cntFinal">Finalize count</button><button class="dogo-btn dogo-btn--outline" id="cntCancel">Cancel count</button>' : '') + '</div>' +
      '<div class="dogo-table-wrap"><table class="dogo-table"><thead><tr><th>Product</th><th style="text-align:right;">System</th><th style="text-align:right;">Counted</th><th style="text-align:right;">Variance</th></tr></thead><tbody>' +
      (shown.length ? shown.slice(0, 400).map(function (i) {
        var has = i.counted_qty !== null && i.counted_qty !== undefined, d = has ? Number(i.counted_qty) - Number(i.system_qty) : null;
        return '<tr><td><strong>' + esc(i.product_name || '') + '</strong></td><td style="text-align:right;">' + fmt(i.system_qty) + '</td><td style="text-align:right;">' +
          (open ? '<input class="dogo-input" type="number" min="0" step="any" data-cnt-item="' + esc(i.id) + '" value="' + (has ? esc(i.counted_qty) : '') + '" style="width:96px;text-align:right;">' : (has ? fmt(i.counted_qty) : '—')) +
          '</td><td style="text-align:right;font-weight:700;color:' + (d === null || d === 0 ? 'inherit' : d < 0 ? '#b91c1c' : '#047857') + ';" id="cntVar_' + esc(i.id) + '">' + (d === null ? '—' : (d > 0 ? '+' : '') + fmt(d)) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" style="text-align:center;padding:30px;color:var(--dogo-text-muted);">No products match.</td></tr>') +
      '</tbody></table></div>' + (shown.length > 400 ? '<div style="font-size:12.5px;color:var(--dogo-text-muted);margin-top:8px;">Showing the first 400 of ' + shown.length + '. Use search to find the rest.</div>' : '') + '</section>' +
      (open ? '<p style="font-size:12.5px;color:var(--dogo-text-muted);margin-top:10px;">Finalizing adds (counted − system at start) to the live stock, so sales made while you were counting are kept. Products you leave blank are not changed.</p>' : '');
    if (wasFocused) { var s = $('cntSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    $('cntSearch').oninput = function () { drawCount(); };
    $('cntCsv').onclick = function () {
      csv('stock_count.csv', [['Product', 'System', 'Counted', 'Variance']].concat(state.items.map(function (i) {
        var has = i.counted_qty !== null && i.counted_qty !== undefined; return [i.product_name, i.system_qty, has ? i.counted_qty : '', has ? Number(i.counted_qty) - Number(i.system_qty) : ''];
      })));
    };
    el.querySelectorAll('[data-cnt-item]').forEach(function (inp) {
      inp.onchange = function () { saveCounted(inp.getAttribute('data-cnt-item'), inp.value); };
    });
    if ($('cntFinal')) $('cntFinal').onclick = finalizeCount;
    if ($('cntCancel')) $('cntCancel').onclick = cancelCount;
  }
  function kpi(label, val, color) {
    return '<div style="background:var(--dogo-panel);padding:12px 14px;border-radius:12px;"><div class="inv-kpi-label">' + esc(label) + '</div><div style="font-size:19px;font-weight:800;' + (color ? 'color:' + color + ';' : '') + '">' + esc(val) + '</div></div>';
  }
  async function saveCounted(itemId, raw) {
    var val = raw === '' ? null : Number(raw);
    if (val !== null && (!isFinite(val) || val < 0)) return toast('Enter a quantity of 0 or more');
    var r = await sb.from('stock_count_items').update({ counted_qty: val }).eq('id', itemId);
    if (r.error) return toast('Could not save: ' + r.error.message);
    state.items.forEach(function (i) { if (i.id === itemId) i.counted_qty = val; });
    drawCount();
  }
  async function finalizeCount() {
    var n = state.items.filter(function (i) { return i.counted_qty !== null && i.counted_qty !== undefined && Number(i.counted_qty) !== Number(i.system_qty); }).length;
    if (!confirm(n ? 'Finalize this count? Stock will be adjusted for ' + n + ' product' + (n === 1 ? '' : 's') + '. This cannot be undone.' : 'No differences found. Finalize and close this count?')) return;
    var r = await sb.rpc('finalize_stock_count', { p_count_id: state.countId, p_user: ctx.profile ? ctx.profile.id : null });
    if (r.error) return toast('Could not finalize: ' + r.error.message);
    toast('Count finalized: ' + (r.data && r.data.adjusted || 0) + ' product(s) adjusted');
    if (window.DogoData && window.DogoData.notifyProductsChanged) window.DogoData.notifyProductsChanged();
    renderCountDetail();
  }
  async function cancelCount() {
    if (!confirm('Cancel this count? Nothing will be adjusted.')) return;
    var r = await sb.from('stock_counts').update({ status: 'cancelled' }).eq('id', state.countId).eq('status', 'open');
    if (r.error) return toast('Could not cancel: ' + r.error.message);
    state.countId = null; renderCounts();
  }

  /* ------------------------------------------------------------------ lots, expiry, serials, tracking switches */
  async function renderLots() {
    var v = $('view_lots'); if (!v) return;
    v.innerHTML = head('Lots & Expiry', 'Batches received, when they expire, and serial numbers. Lots are sold first-expiry-first-out.') +
      '<div id="lotKpis"></div><section class="dogo-card" style="padding:16px 20px;margin-bottom:14px;"><div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap;">' +
      '<select class="dogo-select" id="lotFilter"><option value="all">All lots in stock</option><option value="expired">Expired</option><option value="30">Expiring in 30 days</option><option value="90">Expiring in 90 days</option></select></div>' +
      '<div class="dogo-table-wrap"><table class="dogo-table"><thead><tr><th>Product</th><th>Lot</th><th>Expiry</th><th style="text-align:right;">Left</th><th style="text-align:right;">Cost</th><th></th></tr></thead><tbody id="lotRows"><tr><td colspan="6" style="padding:24px;text-align:center;color:var(--dogo-text-muted);">Loading…</td></tr></tbody></table></div></section>' +
      '<section class="dogo-card" style="padding:16px 20px;margin-bottom:14px;"><h2 style="font-size:16px;margin:0 0 8px;">Serial numbers</h2>' +
      '<input class="dogo-input" id="serQ" placeholder="Search a serial number…" style="max-width:320px;"><div class="dogo-table-wrap" style="margin-top:10px;"><table class="dogo-table"><thead><tr><th>Serial</th><th>Product</th><th>Status</th><th>Received</th></tr></thead><tbody id="serRows"><tr><td colspan="4" style="padding:18px;color:var(--dogo-text-muted);">Type to search.</td></tr></tbody></table></div>' +
      '<p style="font-size:12.5px;color:var(--dogo-text-muted);margin:8px 0 0;">Serials are recorded when you receive stock. The till does not pick a serial yet, so set a serial to Sold here when you hand it over.</p></section>' +
      '<section class="dogo-card" style="padding:16px 20px;"><h2 style="font-size:16px;margin:0 0 8px;">Tracking switches</h2><input class="dogo-input" id="trkQ" placeholder="Search product…" style="max-width:320px;margin-bottom:10px;"><div id="trkRows"></div></section>';
    $('lotFilter').onchange = loadLots; $('serQ').oninput = debounce(loadSerials, 300); $('trkQ').oninput = drawTracking;
    drawTracking(); loadLots();
  }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  async function loadLots() {
    var rows = $('lotRows'), f = $('lotFilter').value;
    var r = await sb.from('product_lots').select('id,lot_no,expiry_date,qty_remaining,unit_cost,products(name)').gt('qty_remaining', 0).order('expiry_date', { ascending: true, nullsFirst: false }).limit(500);
    if (r.error) { rows.innerHTML = '<tr><td colspan="6" style="padding:24px;color:var(--dogo-text-muted);">' + esc(missing(r.error) ? MISSING : 'Could not load: ' + r.error.message) + '</td></tr>'; return; }
    var today = new Date().toISOString().slice(0, 10), plus = function (d) { return new Date(Date.now() + d * 86400000).toISOString().slice(0, 10); };
    var all = r.data || [], expired = 0, soon = 0;
    all.forEach(function (l) { if (l.expiry_date && l.expiry_date < today) expired += Number(l.qty_remaining); else if (l.expiry_date && l.expiry_date <= plus(30)) soon += Number(l.qty_remaining); });
    $('lotKpis').innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px;">' + kpi('Expired (units)', fmt(expired), expired ? '#b91c1c' : null) + kpi('Expiring in 30 days (units)', fmt(soon), soon ? '#b45309' : null) + kpi('Lots in stock', String(all.length)) + '</div>';
    var list = all.filter(function (l) {
      if (f === 'expired') return l.expiry_date && l.expiry_date < today;
      if (f === '30') return l.expiry_date && l.expiry_date >= today && l.expiry_date <= plus(30);
      if (f === '90') return l.expiry_date && l.expiry_date >= today && l.expiry_date <= plus(90);
      return true;
    });
    rows.innerHTML = list.length ? list.map(function (l) {
      var exp = l.expiry_date && l.expiry_date < today, near = l.expiry_date && !exp && l.expiry_date <= plus(30);
      return '<tr><td><strong>' + esc(l.products ? l.products.name : '—') + '</strong></td><td>' + esc(l.lot_no || '—') + '</td><td>' + esc(day(l.expiry_date)) + ' ' +
        (exp ? badge('Expired', '#fee2e2', '#991b1b') : near ? badge('Soon', '#fef3c7', '#92400e') : '') + '</td><td style="text-align:right;">' + fmt(l.qty_remaining) + '</td><td style="text-align:right;">' + (l.unit_cost === null ? '—' : ksh(l.unit_cost)) + '</td><td>' +
        (canManage ? '<button class="dogo-btn dogo-btn--outline dogo-btn--sm" data-writeoff="' + esc(l.id) + '">Write off</button>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--dogo-text-muted);">' + (all.length ? 'No lots match this filter.' : 'No lots yet. Turn on lot tracking below, then enter a lot and expiry when you receive stock.') + '</td></tr>';
    rows.onclick = async function (e) {
      var id = e.target.getAttribute && e.target.getAttribute('data-writeoff'); if (!id) return;
      if (!confirm('Write off what is left of this lot? Stock goes down by that quantity.')) return;
      var w = await sb.rpc('write_off_lot', { p_lot_id: id, p_note: null });
      if (w.error) return toast('Could not write off: ' + w.error.message);
      toast('Written off ' + fmt(w.data) + ' unit(s)'); if (window.DogoData.notifyProductsChanged) window.DogoData.notifyProductsChanged(); loadLots();
    };
  }
  async function loadSerials() {
    var q = ($('serQ').value || '').trim(), rows = $('serRows');
    if (!q) { rows.innerHTML = '<tr><td colspan="4" style="padding:18px;color:var(--dogo-text-muted);">Type to search.</td></tr>'; return; }
    var r = await sb.from('product_serials').select('id,serial_no,status,received_at,products(name)').ilike('serial_no', '%' + q.replace(/[%_]/g, '') + '%').limit(50);
    if (r.error) { rows.innerHTML = '<tr><td colspan="4" style="padding:18px;color:var(--dogo-text-muted);">' + esc(missing(r.error) ? MISSING : r.error.message) + '</td></tr>'; return; }
    rows.innerHTML = (r.data || []).length ? r.data.map(function (s) {
      return '<tr><td><strong>' + esc(s.serial_no) + '</strong></td><td>' + esc(s.products ? s.products.name : '—') + '</td><td><select class="dogo-select" data-serial="' + esc(s.id) + '">' +
        ['in_stock', 'sold', 'returned', 'written_off'].map(function (st) { return '<option value="' + st + '"' + (st === s.status ? ' selected' : '') + '>' + st.replace('_', ' ') + '</option>'; }).join('') +
        '</select></td><td>' + esc(when(s.received_at)) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" style="padding:18px;color:var(--dogo-text-muted);">No serial number matches.</td></tr>';
    rows.onchange = async function (e) {
      var id = e.target.getAttribute && e.target.getAttribute('data-serial'); if (!id) return;
      var u = await sb.from('product_serials').update({ status: e.target.value }).eq('id', id);
      toast(u.error ? 'Could not update: ' + u.error.message : 'Serial updated');
    };
  }
  function drawTracking() {
    var q = ($('trkQ').value || '').trim().toLowerCase(), box = $('trkRows');
    var list = getProducts().filter(function (p) { return !q || String(p.name).toLowerCase().indexOf(q) >= 0 || String(p.code || '').toLowerCase().indexOf(q) >= 0; }).slice(0, 60);
    box.innerHTML = list.length ? '<div class="dogo-table-wrap"><table class="dogo-table"><thead><tr><th>Product</th><th>Track lots / expiry</th><th>Track serials</th></tr></thead><tbody>' + list.map(function (p) {
      return '<tr><td><strong>' + esc(p.name) + '</strong></td><td><input type="checkbox" data-trk="track_lots" data-id="' + esc(p.id) + '"' + (p.track_lots ? ' checked' : '') + '></td><td><input type="checkbox" data-trk="track_serials" data-id="' + esc(p.id) + '"' + (p.track_serials ? ' checked' : '') + '></td></tr>';
    }).join('') + '</tbody></table></div>' + (getProducts().length > 60 && !q ? '<div style="font-size:12.5px;color:var(--dogo-text-muted);margin-top:6px;">Showing 60 products. Search for others.</div>' : '') : '<div style="color:var(--dogo-text-muted);">No products match.</div>';
    box.onchange = async function (e) {
      var col = e.target.getAttribute && e.target.getAttribute('data-trk'); if (!col) return;
      var patch = {}; patch[col] = e.target.checked;
      var u = await sb.from('products').update(patch).eq('id', e.target.getAttribute('data-id'));
      if (u.error) { e.target.checked = !e.target.checked; return toast(missing(u.error) ? MISSING : 'Could not save: ' + u.error.message); }
      getProducts().forEach(function (p) { if (p.id === e.target.getAttribute('data-id')) p[col] = e.target.checked; });
      toast('Saved');
    };
  }

  /* ------------------------------------------------------------------ cost history */
  function renderCosts() {
    var v = $('view_costs'); if (!v) return;
    v.innerHTML = head('Cost History', 'Every change to a product\u2019s buying price, and what caused it.') +
      '<section class="dogo-card" style="padding:16px 20px;"><select class="dogo-select" id="chProduct" style="max-width:420px;margin-bottom:12px;">' + prodOptions('Select a product') + '</select><div id="chBody" style="color:var(--dogo-text-muted);">Pick a product to see its buying price history.</div></section>';
    $('chProduct').onchange = loadCosts;
  }
  async function loadCosts() {
    var id = $('chProduct').value, body = $('chBody'); if (!id) { body.textContent = 'Pick a product to see its buying price history.'; return; }
    var r = await sb.from('product_cost_history').select('created_at,old_cost,new_cost,reason').eq('product_id', id).order('created_at', { ascending: false }).limit(200);
    if (r.error) { body.textContent = missing(r.error) ? MISSING : 'Could not load: ' + r.error.message; return; }
    var cur = getProducts().filter(function (p) { return p.id === id; })[0], why = { opening: 'Opening price', purchase: 'Purchase (weighted average)', manual: 'Edited by hand', count: 'Stock count', sale: 'Sale' };
    body.innerHTML = '<div style="margin-bottom:10px;color:var(--dogo-ink);">Current buying price: <strong>' + (cur && cur.cost !== null && cur.cost !== undefined && cur.cost !== '' ? ksh(cur.cost) : 'not set') + '</strong></div>' +
      ((r.data || []).length ? '<div class="dogo-table-wrap"><table class="dogo-table"><thead><tr><th>Date</th><th style="text-align:right;">Was</th><th style="text-align:right;">Now</th><th style="text-align:right;">Change</th><th>Reason</th></tr></thead><tbody>' + r.data.map(function (h) {
        var pct = h.old_cost !== null && Number(h.old_cost) > 0 ? (Number(h.new_cost) - Number(h.old_cost)) / Number(h.old_cost) * 100 : null;
        return '<tr><td style="white-space:nowrap;">' + esc(when(h.created_at)) + '</td><td style="text-align:right;">' + (h.old_cost === null ? '—' : ksh(h.old_cost)) + '</td><td style="text-align:right;"><strong>' + ksh(h.new_cost) + '</strong></td><td style="text-align:right;font-weight:700;color:' + (pct === null ? 'inherit' : pct > 0 ? '#b91c1c' : '#047857') + ';">' + (pct === null ? '—' : (pct > 0 ? '+' : '') + pct.toFixed(1) + '%') + '</td><td>' + esc(why[h.reason] || h.reason || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : 'No price changes recorded yet. They are tracked from now on.');
  }

  window.DogoInvExtras = { init: init, onTab: onTab };
})();
