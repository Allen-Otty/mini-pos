/* "Scan invoice" flow: photo -> read (AI when online, on-device OCR otherwise) -> review/edit -> commit.
   The commit itself (stock, buying prices, supplier, expense/payable) is done by the page via onCommit(),
   so it reuses the exact same safe stock-update code as manual purchase orders. */
(function (root) {
  'use strict';
  var P = root.DogoInvoiceParse;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var r2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var todayIso = function () { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  /* ---------------- reading the photo ---------------- */
  function loadImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not open that image.')); };
      img.src = url;
    });
  }
  function toCanvas(img, max) {
    var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  function enhance(canvas) {           // grayscale + contrast stretch: helps OCR on phone photos
    var c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    var x = c.getContext('2d'); x.drawImage(canvas, 0, 0);
    var d = x.getImageData(0, 0, c.width, c.height), p = d.data, lo = 255, hi = 0, i, g;
    for (i = 0; i < p.length; i += 4) { g = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114; p[i] = g; if (g < lo) lo = g; if (g > hi) hi = g; }
    var k = hi > lo ? 255 / (hi - lo) : 1;
    for (i = 0; i < p.length; i += 4) { g = Math.max(0, Math.min(255, (p[i] - lo) * k)); p[i] = p[i + 1] = p[i + 2] = g; }
    x.putImageData(d, 0, 0);
    return c;
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Could not load the reader (needs internet the first time).')); };
      document.head.appendChild(s);
    });
  }
  async function ocr(canvas, onProgress) {
    if (!root.Tesseract) await loadScript(root.DOGO_TESS ? root.DOGO_TESS.script : 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js');
    var opts = { logger: function (m) { if (m && m.status === 'recognizing text' && onProgress) onProgress(Math.round((m.progress || 0) * 100)); } };
    if (root.DOGO_TESS) { opts.workerPath = root.DOGO_TESS.worker; opts.corePath = root.DOGO_TESS.core; opts.langPath = root.DOGO_TESS.lang; opts.workerBlobURL = false; }
    var worker = await root.Tesseract.createWorker(opts);
    try {
      await worker.loadLanguage('eng'); await worker.initialize('eng');
      var r = await worker.recognize(enhance(canvas));
      return (r && r.data && r.data.text) || '';
    } finally { try { await worker.terminate(); } catch (e) { /* ignore */ } }
  }

  function apiBase() {
    var custom = localStorage.getItem('dogo_api_url') || (root.DOGO_CONFIG && root.DOGO_CONFIG.api_url);
    if (custom) return custom.replace(/\/+$/, '');
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return '';
    return null;
  }
  async function aiExtract(canvas, getToken) {
    var base = apiBase();
    if (base === null || navigator.onLine === false) return null;
    var off = Number(sessionStorage.getItem('dogo_ai_scan_off') || 0);
    if (off && Date.now() - off < 10 * 60 * 1000) return null;       // server said "not available" recently
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 45000);
    try {
      var token = getToken ? await getToken() : null;
      var resp = await fetch(base + '/api/scan-invoice', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
        body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.85).split(',')[1], mime: 'image/jpeg' })
      });
      if (!resp.ok) { if (resp.status === 404 || resp.status === 501 || resp.status === 503) sessionStorage.setItem('dogo_ai_scan_off', String(Date.now())); return null; }
      var j = await resp.json();
      return j && j.invoice ? normalizeAi(j.invoice) : null;
    } catch (e) { return null; } finally { clearTimeout(timer); }
  }
  function normalizeAi(a) {
    var out = { supplier: { name: String((a.supplier && a.supplier.name) || a.supplier_name || ''), phone: String((a.supplier && a.supplier.phone) || ''), pin: String((a.supplier && a.supplier.pin) || '') },
      invoice_no: String(a.invoice_no || ''), date: P.parseDate(String(a.date || '')) || String(a.date || ''), due_date: String(a.due_date || ''),
      items: [], subtotal: a.subtotal == null ? null : Number(a.subtotal), vat: a.vat == null ? null : Number(a.vat), total: a.total == null ? null : Number(a.total),
      paid_hint: typeof a.paid === 'boolean' ? a.paid : null, warnings: [], source: 'ai' };
    (a.items || []).forEach(function (i) {
      var q = Number(i.qty) || 1, u = Number(i.unit_cost != null ? i.unit_cost : i.unit_price), t = Number(i.total);
      if (!isFinite(u) && isFinite(t)) u = t / q; if (!isFinite(t) && isFinite(u)) t = u * q;
      if (isFinite(u) && isFinite(t) && String(i.description || '').trim()) out.items.push({ description: String(i.description).trim(), qty: r2(q), unit_cost: r2(u), total: r2(t), flag: '' });
    });
    if (!out.items.length) out.warnings.push('The AI could not find item lines - please add them by hand.');
    if (out.total == null) out.total = r2(out.items.reduce(function (s, i) { return s + i.total; }, 0));
    return out;
  }

  /* ---------------- UI ---------------- */
  var CSS = '.dis{position:fixed;inset:0;z-index:3000;background:#f5f6f8;color:#111;display:flex;flex-direction:column;font-family:inherit}' +
    '.dis *{box-sizing:border-box}.dis-top{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#fff;border-bottom:1px solid #e5e7eb}' +
    '.dis-top h2{margin:0;font-size:17px;flex:1}.dis-x{border:0;background:#eef0f3;border-radius:10px;width:36px;height:36px;font-size:20px;cursor:pointer}' +
    '.dis-body{flex:1;overflow:auto;padding:14px;max-width:760px;width:100%;margin:0 auto}' +
    '.dis-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;margin-bottom:12px}' +
    '.dis-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;border-radius:12px;border:0;font-size:15px;font-weight:700;cursor:pointer;background:#d97706;color:#fff}' +
    '.dis-btn.alt{background:#fff;color:#111;border:1px solid #d1d5db}.dis-btn[disabled]{opacity:.55;cursor:default}' +
    '.dis label{display:block;font-size:12px;font-weight:700;color:#4b5563;margin:8px 0 3px}' +
    '.dis input,.dis select{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;background:#fff;color:#111}' +
    '.dis-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.dis-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}' +
    '.dis-line{border:1px solid #e5e7eb;border-radius:12px;padding:10px;margin-bottom:10px;background:#fafafa}' +
    '.dis-warn{background:#fef3c7;border:1px solid #fcd34d;color:#78350f;border-radius:10px;padding:9px 11px;font-size:13px;margin-bottom:10px}' +
    '.dis-seg{display:flex;gap:8px}.dis-seg button{flex:1;padding:10px;border-radius:10px;border:1px solid #d1d5db;background:#fff;font-weight:700;cursor:pointer}' +
    '.dis-seg button.on{background:#111;color:#fff;border-color:#111}.dis-muted{color:#6b7280;font-size:12.5px}' +
    '.dis-sum{display:flex;justify-content:space-between;font-size:14px;margin:4px 0}.dis-sum b{font-size:16px}' +
    '.dis-img{max-width:100%;max-height:300px;border-radius:12px;display:block;margin:0 auto 12px;border:1px solid #e5e7eb}' +
    '.dis-del{border:0;background:transparent;color:#b91c1c;font-weight:700;cursor:pointer;font-size:13px}';

  function open(ctx) {
    ctx = ctx || {};
    if (!document.getElementById('dis-css')) { var st = document.createElement('style'); st.id = 'dis-css'; st.textContent = CSS; document.head.appendChild(st); }
    var products = (ctx.products || []).filter(function (p) { return !p.archived; });
    var suppliers = ctx.suppliers || [];
    var el = document.createElement('div'); el.className = 'dis';
    document.body.appendChild(el);
    var canvas = null, inv = null, busy = false, paid = true;

    function close() { if (el.parentNode) el.parentNode.removeChild(el); }
    function shell(title, inner) {
      el.innerHTML = '<div class="dis-top"><h2>' + esc(title) + '</h2><button class="dis-x" data-a="close" aria-label="Close">&times;</button></div><div class="dis-body">' + inner + '</div>';
    }

    /* step 1: capture */
    function stepCapture(msg, err) {
      shell('Scan invoice', (err ? '<div class="dis-warn">' + esc(err) + '</div>' : '') +
        '<div class="dis-card">' + (canvas ? '<img class="dis-img" src="' + canvas.toDataURL('image/jpeg', 0.5) + '" alt="Invoice preview">' : '<p class="dis-muted" style="margin-top:0">Take a clear, well-lit photo of the supplier invoice or delivery note. Keep the whole page in view and flat.</p>') +
        '<label class="dis-btn" style="cursor:pointer">&#128247; ' + (canvas ? 'Retake photo' : 'Take photo') + '<input type="file" accept="image/*" capture="environment" data-a="file" hidden></label>' +
        '<label class="dis-btn alt" style="cursor:pointer;margin-top:8px">&#128444; Choose from gallery<input type="file" accept="image/*" data-a="file" hidden></label>' +
        (canvas ? '<button class="dis-btn" style="margin-top:10px;background:#047857" data-a="read"' + (busy ? ' disabled' : '') + '>' + (busy ? esc(msg || 'Reading…') : 'Read invoice') + '</button>' : '') +
        '<button class="dis-btn alt" style="margin-top:8px" data-a="manual">Type it in by hand instead</button></div>' +
        '<p class="dis-muted">Reads with AI when you are online and the server supports it, otherwise on this device (works offline). You can correct everything before it is saved.</p>');
    }
    async function doRead() {
      if (!canvas || busy) return;
      busy = true; stepCapture('Reading…');
      var setMsg = function (t) { var b = el.querySelector('[data-a="read"]'); if (b) b.textContent = t; };
      try {
        setMsg('Reading with AI…');
        var r = await aiExtract(canvas, ctx.getToken);
        if (!r) {
          setMsg('Reading on this device…');
          var text = await ocr(canvas, function (p) { setMsg('Reading on this device… ' + p + '%'); });
          r = P.parse(text); r.source = 'ocr'; r.rawText = text;
        }
        inv = r; paid = r.paid_hint !== false; busy = false; stepReview();
      } catch (e) { busy = false; stepCapture('', (e && e.message) || 'Could not read the invoice.'); }
    }
    function blank() {
      return { supplier: { name: '', phone: '', pin: '' }, invoice_no: '', date: todayIso(), due_date: '', items: [], subtotal: null, vat: null, total: null, paid_hint: null, warnings: [], source: 'manual' };
    }

    /* step 2: review */
    function suggest(it) { var m = P.matchProduct(it.description, products); it.productId = m ? m.id : (it.productId || ''); it.sell_price = it.sell_price || Math.max(1, Math.round(it.unit_cost * 1.25)); }
    function productOptions(sel) {
      return '<option value="">&#10133; Create as new product</option><option value="skip"' + (sel === 'skip' ? ' selected' : '') + '>Do not add to stock</option>' +
        products.map(function (p) { return '<option value="' + esc(p.id) + '"' + (sel === p.id ? ' selected' : '') + '>' + esc(p.name) + ' (stock ' + (p.stock == null ? 0 : p.stock) + ')</option>'; }).join('');
    }
    function lineHtml(it, i) {
      return '<div class="dis-line" data-i="' + i + '"><label style="margin-top:0">Item as on invoice</label><input data-f="description" value="' + esc(it.description) + '">' +
        '<div class="dis-row3"><div><label>Qty</label><input data-f="qty" type="number" step="any" inputmode="decimal" value="' + esc(it.qty) + '"></div>' +
        '<div><label>Unit cost</label><input data-f="unit_cost" type="number" step="any" inputmode="decimal" value="' + esc(it.unit_cost) + '"></div>' +
        '<div><label>Line total</label><input data-f="total" type="number" step="any" inputmode="decimal" value="' + esc(it.total) + '"></div></div>' +
        '<label>Add to product</label><select data-f="productId">' + productOptions(it.productId) + '</select>' +
        (!it.productId ? '<label>Selling price for the new product</label><input data-f="sell_price" type="number" step="any" inputmode="decimal" value="' + esc(it.sell_price) + '">' : '') +
        '<div style="text-align:right;margin-top:6px"><button class="dis-del" data-a="del" data-i="' + i + '">Remove line</button></div></div>';
    }
    function totalIsAuto() {      // the total still equals what the lines add up to (so keep it in step)
      var sum = sums().items, vat = Number(inv.vat) || 0;
      return inv.total == null || Math.abs(inv.total - sum) < 0.01 || Math.abs(inv.total - sum - vat) < 0.01;
    }
    function sums() {
      var items = r2(inv.items.reduce(function (s, i) { return s + (Number(i.total) || 0); }, 0));
      return { items: items };
    }
    function stepReview() {
      inv.items.forEach(function (it) { if (it.productId === undefined) suggest(it); });
      var s = sums(); if (inv.total == null) inv.total = s.items; var total = inv.total;
      var warn = (inv.warnings || []).map(function (w) { return '<div class="dis-warn">' + esc(w) + '</div>'; }).join('');
      shell('Check the invoice', warn +
        '<div class="dis-card"><label style="margin-top:0">Supplier</label><input data-s="name" list="dis-sup" value="' + esc(inv.supplier.name) + '" placeholder="Supplier name">' +
        '<datalist id="dis-sup">' + suppliers.map(function (x) { return '<option value="' + esc(x.name) + '">'; }).join('') + '</datalist>' +
        '<div class="dis-row"><div><label>Phone</label><input data-s="phone" value="' + esc(inv.supplier.phone) + '"></div><div><label>KRA PIN</label><input data-s="pin" value="' + esc(inv.supplier.pin) + '"></div></div>' +
        '<div class="dis-row"><div><label>Invoice no.</label><input data-h="invoice_no" value="' + esc(inv.invoice_no) + '"></div><div><label>Invoice date</label><input data-h="date" type="date" value="' + esc(inv.date) + '"></div></div></div>' +
        '<div class="dis-card"><div style="font-weight:800;margin-bottom:6px">Items (' + inv.items.length + ')</div><div id="dis-lines">' + inv.items.map(lineHtml).join('') + '</div>' +
        '<button class="dis-btn alt" data-a="add">+ Add a line</button></div>' +
        '<div class="dis-card"><div class="dis-sum"><span>Items total</span><span id="dis-items">Ksh ' + fmt(s.items) + '</span></div>' +
        '<label>VAT on the invoice (optional)</label><input data-h="vat" type="number" step="any" inputmode="decimal" value="' + (inv.vat == null ? '' : esc(inv.vat)) + '">' +
        '<label>Total payable to supplier</label><input data-h="total" type="number" step="any" inputmode="decimal" value="' + esc(total) + '">' +
        '<label>Payment</label><div class="dis-seg"><button data-a="paid" class="' + (paid ? 'on' : '') + '">Paid now</button><button data-a="credit" class="' + (!paid ? 'on' : '') + '">On credit</button></div>' +
        (!paid ? '<label>Pay by (due date)</label><input data-h="due_date" type="date" value="' + esc(inv.due_date) + '"><div class="dis-muted" style="margin-top:4px">Saved as an unpaid invoice you can mark as paid later.</div>'
          : '<div class="dis-muted" style="margin-top:6px">Recorded as a Stock Purchases expense today.</div>') + '</div>' +
        '<div id="dis-err"></div><button class="dis-btn" style="background:#047857" data-a="save"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving…' : 'Save &amp; update stock') + '</button>' +
        '<button class="dis-btn alt" style="margin-top:8px" data-a="back">Back</button>');
    }

    function validate() {
      if (!inv.supplier.name.trim()) return 'Enter the supplier name.';
      var lines = inv.items.filter(function (i) { return String(i.description).trim(); });
      if (!lines.length) return 'Add at least one item.';
      for (var k = 0; k < lines.length; k++) {
        var i = lines[k];
        if (!(Number(i.qty) > 0)) return 'Check the quantity for "' + i.description + '".';
        if (!(Number(i.unit_cost) >= 0)) return 'Check the unit cost for "' + i.description + '".';
        if (i.productId === '' && !(Number(i.sell_price) > 0)) return 'Enter a selling price for the new product "' + i.description + '".';
      }
      if (!(Number(inv.total) > 0)) return 'Enter the total payable.';
      return '';
    }
    async function save() {
      if (busy) return;
      var msg = validate(), box = el.querySelector('#dis-err');
      if (msg) { if (box) box.innerHTML = '<div class="dis-warn">' + esc(msg) + '</div>'; return; }
      busy = true; stepReview();
      try {
        await ctx.onCommit({
          supplier: inv.supplier, invoice_no: inv.invoice_no, date: inv.date || todayIso(), due_date: paid ? '' : (inv.due_date || ''), paid: paid,
          vat: inv.vat == null || inv.vat === '' ? 0 : Number(inv.vat), total: r2(inv.total), source: inv.source,
          items: inv.items.filter(function (i) { return String(i.description).trim(); }).map(function (i) {
            return { description: String(i.description).trim(), qty: Number(i.qty), unit_cost: Number(i.unit_cost), total: r2(i.total),
              productId: i.productId === 'skip' ? null : (i.productId || null), createNew: i.productId === '', skip: i.productId === 'skip', sell_price: Number(i.sell_price) || 0 };
          })
        });
        close();
      } catch (e) { busy = false; stepReview(); var b2 = el.querySelector('#dis-err'); if (b2) b2.innerHTML = '<div class="dis-warn">' + esc((e && e.message) || 'Could not save.') + '</div>'; }
    }

    /* events */
    el.addEventListener('click', function (e) {
      var t = e.target.closest('[data-a]'); if (!t) return;
      var a = t.getAttribute('data-a');
      if (a === 'close') { if (!busy) close(); }
      else if (a === 'read') doRead();
      else if (a === 'manual') { inv = blank(); paid = true; stepReview(); }
      else if (a === 'back') { inv = null; stepCapture(); }
      else if (a === 'add') { inv.items.push({ description: '', qty: 1, unit_cost: 0, total: 0, productId: '', sell_price: 0 }); stepReview(); }
      else if (a === 'del') { var auto = totalIsAuto(); inv.items.splice(Number(t.getAttribute('data-i')), 1); if (auto) inv.total = null; stepReview(); }
      else if (a === 'paid') { paid = true; stepReview(); }
      else if (a === 'credit') { paid = false; stepReview(); }
      else if (a === 'save') save();
    });
    el.addEventListener('change', async function (e) {
      var t = e.target;
      if (t.matches('input[type=file]') && t.files && t.files[0]) {
        try { canvas = toCanvas(await loadImage(t.files[0]), 1800); stepCapture(); } catch (err) { stepCapture('', err.message); }
        return;
      }
      if (!inv) return;
      var line = t.closest('.dis-line'), f = t.getAttribute('data-f');
      if (line && f) {
        var wasAuto = totalIsAuto();
        var it = inv.items[Number(line.getAttribute('data-i'))];
        if (f === 'description' || f === 'productId') it[f] = t.value; else it[f] = t.value === '' ? '' : Number(t.value);
        if (f === 'qty' || f === 'unit_cost') it.total = r2((Number(it.qty) || 0) * (Number(it.unit_cost) || 0));
        if (f === 'description' && !it.productId) { var m = P.matchProduct(it.description, products); if (m) it.productId = m.id; }
        if (f === 'total' && Number(it.qty) > 0) it.unit_cost = r2(Number(it.total) / Number(it.qty));
        // suggested selling price for a new product follows the unit cost until the user types their own
        if (f === 'sell_price') it._ownSell = true;
        if (!it.productId && !it._ownSell) it.sell_price = Math.max(0, Math.round((Number(it.unit_cost) || 0) * 1.25));
        if (wasAuto) inv.total = null;
        stepReview(); return;
      }
      var s = t.getAttribute('data-s'), h = t.getAttribute('data-h');
      if (s) inv.supplier[s] = t.value;
      if (s === 'name') { var sup = suppliers.filter(function (x) { return x.name.toLowerCase() === t.value.trim().toLowerCase(); })[0]; if (sup) { inv.supplier.phone = inv.supplier.phone || sup.phone || ''; stepReview(); } }
      if (h) inv[h] = (h === 'vat' || h === 'total') ? (t.value === '' ? null : Number(t.value)) : t.value;
    });

    stepCapture();
    return { close: close };
  }

  root.DogoInvoiceScan = { open: open, normalizeAi: normalizeAi };
})(typeof window !== 'undefined' ? window : globalThis);
