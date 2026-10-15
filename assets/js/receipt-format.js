/* Supermarket-style till receipt (Kenyan retail layout):
   date / receipt no, business details with PIN and Buy Goods Till, "served by",
   item table (Qty, Unit price incl. VAT, Ext price excl. VAT), subtotal, VAT, total,
   tendered / change, footer notes and a Code 128 barcode of the receipt number.
   Pure functions - no network, works offline. */
(function (root) {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var money = function (n) {
    return 'Ksh' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var pad2 = function (n) { return String(n).padStart(2, '0'); };

  /* ---------- Code 128 (subset B) ---------- */
  var PATTERNS = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
    '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 ' +
    '131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 ' +
    '213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
    '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 ' +
    '421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');

  function code128Modules(text) {
    var codes = [104]; // Start B
    var sum = 104;
    for (var i = 0; i < text.length; i++) {
      var v = text.charCodeAt(i) - 32;
      if (v < 0 || v > 95) v = 0;          // anything unprintable becomes a space
      codes.push(v);
      sum += v * (i + 1);
    }
    codes.push(sum % 103);
    codes.push(106);                       // Stop
    var widths = codes.map(function (c) { return PATTERNS[c]; }).join('');
    return widths;                          // alternating bar, space, bar ... widths
  }

  function barcodeSvg(text, opts) {
    opts = opts || {};
    var unit = opts.unit || 1.4, height = opts.height || 44;
    var widths = code128Modules(String(text || ''));
    var x = 10 * unit, bars = '';             // 10-module quiet zone each side
    for (var i = 0; i < widths.length; i++) {
      var w = Number(widths[i]) * unit;
      if (i % 2 === 0) bars += '<rect x="' + x.toFixed(2) + '" y="0" width="' + w.toFixed(2) + '" height="' + height + '"/>';
      x += w;
    }
    var total = x + 10 * unit;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total.toFixed(2) + ' ' + height + '" ' +
      'preserveAspectRatio="none" style="width:100%;height:' + height + 'px;display:block" fill="#000" aria-label="Receipt barcode">' + bars + '</svg>';
  }

  /* ---------- per-device extras (till number etc.) ---------- */
  function extraKey(businessId) { return 'dogo_receipt_extra_' + (businessId || 'def'); }
  function getExtra(businessId) {
    try { return JSON.parse(localStorage.getItem(extraKey(businessId)) || '{}') || {}; } catch (e) { return {}; }
  }
  function setExtra(businessId, extra) {
    try { localStorage.setItem(extraKey(businessId), JSON.stringify(extra || {})); return true; } catch (e) { return false; }
  }

  var CSS = '.rcpt{font-family:Arial,Helvetica,sans-serif;color:#000;font-size:12px;line-height:1.35}' +
    '.rcpt .top{display:flex;justify-content:space-between;align-items:flex-start;font-size:11px;margin-bottom:8px}' +
    '.rcpt .top b{font-size:12px}.rcpt .ctr{text-align:center}' +
    '.rcpt .biz{font-size:15px;font-weight:700;letter-spacing:.2px;text-transform:uppercase}' +
    '.rcpt .till{font-size:13px;font-weight:800;margin:8px 0 2px}' +
    '.rcpt .served{font-size:11px;margin-bottom:6px}' +
    '.rcpt .cols,.rcpt .row{display:grid;grid-template-columns:1fr 34px 62px 62px;gap:4px;align-items:baseline}' +
    '.rcpt .cols{font-size:10.5px;font-weight:700;border-bottom:1px solid #000;padding-bottom:2px}' +
    '.rcpt .cols span:nth-child(n+2),.rcpt .row span:nth-child(n+2){text-align:right}' +
    '.rcpt .item{border-bottom:1px solid #bbb;padding:4px 0 3px}' +
    '.rcpt .item .nm{font-size:11.5px;text-transform:uppercase;margin-top:1px}' +
    '.rcpt .sum{display:flex;justify-content:flex-end;gap:14px;margin:2px 0}' +
    '.rcpt .sum.vat{justify-content:space-between}' +
    '.rcpt .grand{display:flex;justify-content:flex-end;gap:8px;font-weight:800;font-size:13px;margin:4px 0}' +
    '.rcpt .pay{display:flex;justify-content:space-between;font-size:12px;margin:1px 0;padding:0 6px}' +
    '.rcpt .foot{text-align:center;font-size:11.5px;text-transform:uppercase;margin-top:12px;line-height:1.5}' +
    '.rcpt .bc{margin-top:12px}';

  function ensureStyle() {
    if (typeof document === 'undefined' || document.getElementById('dogo-receipt-css')) return;
    var st = document.createElement('style');
    st.id = 'dogo-receipt-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* opts: business, profile, receiptNo, items[{name,qty,price,vat,unit}], grand, now,
           mpesaReceipt, gatewayName, tendered, orderLine */
  function build(opts) {
    ensureStyle();
    var b = opts.business || {}, items = opts.items || [], now = opts.now || new Date();
    var extra = getExtra(b.id);
    var showVat = b.receipt_show_vat_breakdown !== false;
    var showLogo = b.receipt_show_logo !== false;

    var subtotal = 0, vatTotal = 0, grand = 0;
    var rows = items.map(function (it) {
      var rate = Number(it.vat) || 0, qty = Number(it.qty) || 0, price = Number(it.price) || 0;
      var line = price * qty, ext = line / (1 + rate);
      subtotal += ext; vatTotal += line - ext; grand += line;
      var unitTxt = it.unit && it.unit !== 'piece' ? ' ' + esc(it.unit) : '';
      return '<div class="item"><div class="row"><span></span><span>' + esc(qty) + unitTxt + '</span><span>' + money(price) + '</span><span>' + money(ext) + '</span></div>' +
        '<div class="nm">' + esc(it.name) + '</div></div>';
    }).join('');
    if (opts.grand != null && isFinite(opts.grand)) grand = Number(opts.grand);

    var d = pad2(now.getDate()) + '/' + pad2(now.getMonth() + 1) + '/' + now.getFullYear() + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    var served = opts.profile && opts.profile.full_name ? String(opts.profile.full_name).toUpperCase() : '';
    var phone = b.receipt_phone || '';
    var footer = (b.receipt_footer && b.receipt_footer !== 'Thank you for your business!')
      ? esc(b.receipt_footer) + '<br>'
      : 'Thank you for shopping with us<br>';
    var vatNote = items.some(function (i) { return Number(i.vat) > 0; }) ? 'All items are inclusive of 16% VAT where applicable<br>' : '';

    var tendered = Number(opts.tendered) || 0;
    var payHtml = '';
    if (opts.mpesaReceipt) {
      payHtml = '<div class="pay"><span>' + esc(opts.gatewayName || 'M-Pesa') + ' Ref:</span><span>' + esc(opts.mpesaReceipt) + '</span></div>';
    } else if (tendered >= grand && tendered > 0) {
      payHtml = '<div class="pay"><span>Amount Tendered:</span><span>' + money(tendered) + '</span></div>' +
        '<div class="pay"><span>Change Given:</span><span>' + money(tendered - grand) + '</span></div>' +
        '<div class="pay"><span>Cash:</span><span>' + money(tendered) + '</span></div>';
    }

    return '<div class="rcpt">' +
      '<div class="top"><div>' + d + (extra.store ? '<br>Store: ' + esc(extra.store) : '') + '</div>' +
      '<div style="text-align:right"><b>Sales Receipt #' + esc(String(opts.receiptNo || '').replace(/^RC-/, '')) + '</b></div></div>' +
      '<div class="ctr">' +
      (showLogo && b.logo_url ? '<img src="' + esc(b.logo_url) + '" alt="" style="max-height:46px;max-width:150px;margin-bottom:4px">' : '') +
      '<div class="biz">' + esc(b.name) + '</div>' +
      (b.location ? '<div>' + esc(b.location) + '</div>' : '') +
      (phone ? '<div>TEL: ' + esc(phone) + '</div>' : '') +
      (b.kra_pin ? '<div>PIN: ' + esc(b.kra_pin) + '</div>' : '') +
      (extra.till ? '<div class="till">BUY GOODS TILL NO: ' + esc(extra.till) + '</div>' : '') +
      (opts.orderLine ? '<div><b>' + esc(opts.orderLine) + '</b></div>' : '') +
      '</div>' +
      (served ? '<div class="served">You were served by: ' + esc(served) + '</div>' : '<div style="height:6px"></div>') +
      '<div class="cols"><span>Item Name</span><span>Qty</span><span>Unit Price</span><span>Ext Price</span></div>' +
      rows +
      (showVat
        ? '<div class="sum"><span>Subtotal:</span><span>' + money(subtotal) + '</span></div>' +
          '<div class="sum vat"><span>&nbsp;&nbsp;&nbsp;16% VAT</span><span>16 % Tax: ' + money(vatTotal) + '</span></div>'
        : '') +
      '<div class="grand"><span>RECEIPT TOTAL:</span><span>' + money(grand) + '</span></div>' +
      payHtml +
      '<div class="foot">' + footer + vatNote + '<br>Please come again</div>' +
      (extra.barcode === false ? '' : '<div class="bc">' + barcodeSvg(opts.receiptNo || '') + '</div>') +
      '</div>';
  }

  root.DogoReceipt = { build: build, barcodeSvg: barcodeSvg, code128Widths: code128Modules, getExtra: getExtra, setExtra: setExtra, money: money };
})(typeof window !== 'undefined' ? window : globalThis);
