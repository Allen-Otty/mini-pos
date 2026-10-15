/* Turns the raw text of a supplier invoice / delivery note / till receipt into
   { supplier, invoice_no, date, due_date, items[], subtotal, vat, total, paid_hint, warnings[] }.
   Pure functions (no DOM, no network) so they run offline and can be unit-tested. */
(function (root) {
  'use strict';

  var CUR = '(?:ksh?s?\\.?|kes|sh\\.?)?';
  var NUM_TOKEN = new RegExp('^' + CUR + '-?\\d[\\d,]*(?:\\.\\d{1,3})?$', 'i');
  var SKIP = /\b(invoice|inv\s*no|tel|phone|mobile|pin|vat\s*no|p\.?\s?o\.?\s*box|date|page|cashier|served|thank|received|signature|terms|delivery|customer|bill\s*to|ship\s*to|account|email|www\.|tax\s*invoice|description|qty|quantity|unit\s*price|ext\s*price|amount|price|item\s*name|receipt|store|workstation|till|buy\s*goods|please|goods|sold|change|tendered|cash|balance|subtotal|sub\s*total|total|vat|tax)\b/i;
  var STOP = /^\s*(sub\s*-?\s*total|total|grand\s*total|amount\s*due|balance|receipt\s*total|net\s*total)\b/i;

  function num(tok) {
    if (tok == null) return NaN;
    var t = String(tok).replace(/^(ksh?s?\.?|kes|sh\.?)/i, '').replace(/\s/g, '');
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    else if (/^-?\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
    else t = t.replace(/,/g, '');
    var n = parseFloat(t);
    return isFinite(n) ? n : NaN;
  }
  var r2 = function (n) { return Math.round(n * 100) / 100; };
  var letters = function (s) { return (String(s).match(/[A-Za-z]/g) || []).length; };

  var CUR_PREFIX = /^(ksh?s?\.?|kes)/i;
  var CUR_ONLY = /^(ksh?s?\.?|kes|sh\.?)$/i;

  // Photo OCR often misreads digits inside amounts printed with a currency prefix (Ksh145.0p, Ksh20000, Kshg49.99).
  function fixAmount(tok) {
    var m = /^(ksh?s?\.?|kes)(.+)$/i.exec(tok);
    if (!m) return { tok: tok, fixed: false };
    if (/^-?\d[\d,]*(\.\d{1,3})?$/.test(m[2])) {
      // a currency-prefixed whole number of 5+ digits ending 00 is almost always an amount whose decimal point was lost (Ksh20000 -> 200.00)
      return /^\d{5,}$/.test(m[2]) && /00$/.test(m[2]) ? { tok: m[1] + m[2].slice(0, -2) + '.' + m[2].slice(-2), fixed: true } : { tok: tok, fixed: false };
    }
    var body = m[2].replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/[Ss]/g, '5').replace(/[Bb]/g, '8').replace(/[gq]/g, '9').replace(/[Zz]/g, '2');
    body = body.replace(/^(\d[\d,]*\.\d)[A-Za-z]$/, '$10');
    if (/^\d{5,}$/.test(body) && /00$/.test(body)) body = body.slice(0, -2) + '.' + body.slice(-2);
    return /^\d[\d,]*(\.\d{1,3})?$/.test(body) ? { tok: m[1] + body, fixed: true } : { tok: tok, fixed: false };
  }
  function isNumTok(t) { return NUM_TOKEN.test(t); }
  // drop stray 1-2 letter / symbol-only tokens at the ends of a line (table edges, wood grain, shadows)
  function junk(t) { return !/\d/.test(t) && (t.length <= 2 || !/[A-Za-z]{3,}/.test(t)); }
  function cleanLine(line) {
    var t = String(line).replace(/[|¢©®™“”‘’~^_]/g, ' ').split(/\s+/).filter(Boolean).map(function (x) { return x.replace(/^['"`]+/, ''); }).filter(Boolean);
    while (t.length > 1 && junk(t[0])) t.shift();
    if (t.length >= 3 && /^\d{1,2}[a-z]{1,2}$/i.test(t[0])) t.shift();          // leading "2g" / "5x" specks
    while (t.length > 1 && junk(t[t.length - 1])) t.pop();
    return t.join(' ');
  }

  function splitLine(line) {
    var toks = cleanLine(line).split(/\s+/).filter(Boolean), fixedAny = false;
    toks = toks.map(function (x) { var f = fixAmount(x); if (f.fixed) fixedAny = true; return f.tok; });
    // price row: two or more amounts with a currency prefix (till receipts) -> the text on the line is noise
    var curIdx = [];
    toks.forEach(function (x, i) { if (CUR_PREFIX.test(x) && isNumTok(x)) curIdx.push(i); });
    if (curIdx.length >= 2) {
      var nums = curIdx.map(function (i) { return { raw: toks[i], v: num(toks[i]), cur: true }; });
      for (var j = curIdx[0] - 1; j >= Math.max(0, curIdx[0] - 3); j--) {
        if (/^\d{1,4}$/.test(toks[j])) { nums.unshift({ raw: toks[j], v: num(toks[j]) }); break; }
      }
      return { text: '', nums: nums, priceRow: true, fixed: fixedAny };
    }
    var nums2 = [], i = toks.length - 1;
    while (i >= 0 && (isNumTok(toks[i]) || CUR_ONLY.test(toks[i]) || /^[x×]$/i.test(toks[i]) || /^\d+%$/.test(toks[i]))) {
      if (isNumTok(toks[i])) nums2.unshift({ raw: toks[i], v: num(toks[i]), cur: CUR_PREFIX.test(toks[i]) });
      i--;
    }
    return { text: toks.slice(0, i + 1).join(' ').replace(/[|_]+/g, ' ').trim(), nums: nums2, fixed: fixedAny };
  }

  function parseDate(text) {
    var m = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/.exec(text);
    var y, mo, d;
    if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(text))) {
      d = +m[1]; mo = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(m[2].toLowerCase()) + 1; y = +m[3];
    } else return '';
    if (mo > 12 && d <= 12) { var t = mo; mo = d; d = t; }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return '';
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z'); if (isNaN(d)) return '';
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function lastAmount(line) {
    var s = splitLine(line.replace(/[:=]/g, ' ')).nums;
    return s.length ? s[s.length - 1].v : NaN;
  }

  function parse(text) {
    var out = { supplier: { name: '', phone: '', pin: '' }, invoice_no: '', date: '', due_date: '', items: [], subtotal: null, vat: null, total: null, paid_hint: null, warnings: [] };
    var lines = String(text || '').replace(/\r/g, '').split('\n').map(function (l) { return cleanLine(l.replace(/\s+/g, ' ').trim()); }).filter(Boolean);
    if (!lines.length) { out.warnings.push('No text could be read from the photo.'); return out; }
    var whole = lines.join('\n');

    // ---- header details ----
    var m;
    var invRe = /(?:invoice|inv|delivery[ \t]*note|d\/?note|receipt|doc(?:ument)?)[ \t]*(?:no|number|num|#)?[ \t]*[:.#\-]?[ \t]*([A-Z0-9][A-Z0-9\-\/]{2,})/gi;
    while ((m = invRe.exec(whole))) { if (/\d/.test(m[1])) { out.invoice_no = m[1].toUpperCase(); break; } }
    out.date = parseDate((/date[^\n]*/i.exec(whole) || [''])[0]) || parseDate(whole);
    if ((m = /(?:tel|phone|mob(?:ile)?|cell)[^\d+]{0,6}([+\d][\d\s\-\/]{7,})/i.exec(whole))) out.supplier.phone = m[1].trim().replace(/\s+/g, ' ');
    if ((m = /\bPIN\s*(?:no)?[:.\s]*([A-Z]\d{9}[A-Z])\b/i.exec(whole)) || (m = /\b([AP]\d{9}[A-Z])\b/.exec(whole))) out.supplier.pin = m[1].toUpperCase();
    var due = /due\s*(?:date)?[^\n]*/i.exec(whole);
    if (due) out.due_date = parseDate(due[0]);
    if (!out.due_date && out.date && (m = /(\d{1,3})\s*days/i.exec(whole))) out.due_date = addDays(out.date, +m[1]);

    var bizWord = /\b(ltd|limited|supermarket|wholesale|wholesalers|traders|enterprises|distributors|stores|industries|company|co\.|agencies|suppliers|hardware|chemist)\b/i;
    var head = lines.slice(0, 8).filter(function (l) { return letters(l) >= 3 && !SKIP.test(l) && !/^\d/.test(l); });
    out.supplier.name = (head.filter(function (l) { return bizWord.test(l); })[0] || head[0] || '').replace(/[^\w &.,'\-()]/g, '').trim();

    // ---- totals ----
    lines.forEach(function (l) {
      var a = lastAmount(l);
      if (isNaN(a)) return;
      if (/sub\s*-?\s*total|total\s*excl/i.test(l)) out.subtotal = a;
      else if (/\b(vat|tax)\b/i.test(l) && !/item|inclusive|included|pin|no\b/i.test(l.replace(/\d+\s*%\s*(vat|tax)/i, ''))) out.vat = a;
      else if (/\btotal\b|amount\s*due|balance\s*due|grand/i.test(l) && !/tendered|change/i.test(l)) out.total = a;
    });
    if (/\b(paid|cash\s*sale|tendered|change|m-?pesa\s*ref)\b/i.test(whole)) out.paid_hint = true;
    else if (/\binvoice\b/i.test(whole) || out.due_date) out.paid_hint = false;

    // ---- line items ----
    var end = lines.length;
    for (var k = 0; k < lines.length; k++) if (STOP.test(lines[k]) && k > 1) { end = k; break; }
    var body = lines.slice(0, end).map(function (l) { return { line: l, s: splitLine(l), used: false }; });

    function isTextOnly(b) { return b.s.nums.length === 0 && letters(b.s.text) >= 3 && !SKIP.test(b.s.text); }
    function isNumOnly(b) { return b.s.nums.length >= 1 && (b.s.priceRow || letters(b.s.text) < 3); }

    var below = 0, above = 0;
    body.forEach(function (b, i) {
      if (!isNumOnly(b)) return;
      if (body[i + 1] && isTextOnly(body[i + 1])) below++;
      if (body[i - 1] && isTextOnly(body[i - 1])) above++;
    });
    var nameBelow = below > above;

    function build(desc, nums, raw) {
      nums = nums.slice();
      var qty = 1, unit = NaN, amt = NaN, flag = '';
      (function () {   // drop speck tokens (e.g. "5 £7.") in front of the name
        var tk = desc.split(/\s+/), sym = function (x) { return /[^A-Za-z0-9]/.test(x) && !/[A-Za-z]{3,}/.test(x); };
        while (tk.length > 1 && (sym(tk[0]) || (/^\d{1,2}$/.test(tk[0]) && sym(tk[1])))) tk.shift();
        desc = tk.join(' ');
      })();
      desc = desc.replace(/^\d{1,3}[.)]?\s+(?=[A-Za-z])/, '').replace(/^[\W_]+|[\W_]+$/g, '').trim();
      if (nums.length >= 3) {
        var tail = nums.slice(-4), found = false;
        for (var a = 0; a < tail.length && !found; a++) for (var b2 = a + 1; b2 < tail.length && !found; b2++) for (var c = b2 + 1; c < tail.length && !found; c++) {
          var q = tail[a].v, u = tail[b2].v, t = tail[c].v;
          if (q > 0 && u > 0 && Math.abs(q * u - t) <= Math.max(0.6, t * 0.012)) { qty = q; unit = u; amt = t; found = true; }
        }
        if (!found) {
          qty = nums[nums.length - 3].v; unit = nums[nums.length - 2].v; amt = nums[nums.length - 1].v;
          // unit price incl. 16% VAT with the line amount excl. VAT (common on till receipts) is normal, not an error
          var ratio = qty * unit > 0 ? amt / (qty * unit) : 0;
          if (!(Math.abs(ratio - 1 / 1.16) < 0.02)) flag = 'check';
        }
      } else if (nums.length === 2) {
        var f = nums[0], s2 = nums[1];
        if (/\./.test(f.raw) || f.v > 500) { unit = f.v; amt = s2.v; qty = unit > 0 ? amt / unit : 1; }
        else { qty = f.v; amt = s2.v; unit = qty > 0 ? amt / qty : amt; }
        if (Math.abs(qty - Math.round(qty)) > 0.01 && qty > 0) {
          if (Math.abs(qty - 1 / 1.16) < 0.02) qty = 1; else flag = 'check';
        }
      } else { amt = nums[0].v; unit = amt; qty = 1; }
      if (!(qty > 0) || !(amt >= 0) || isNaN(unit)) return null;
      return { description: desc, qty: r2(qty), unit_cost: r2(unit), total: r2(amt), flag: flag };
    }

    body.forEach(function (b, i) {
      if (b.used) return;
      if (!b.s.priceRow && b.s.nums.length >= 1 && letters(b.s.text) >= 3 && !SKIP.test(b.s.text)) {
        var it = build(b.s.text, b.s.nums, b.line);
        if (it && b.s.fixed) it.flag = 'check';
        if (it && it.total > 0) { it.idx = i; out.items.push(it); b.used = true; }
      }
    });
    body.forEach(function (b, i) {
      if (b.used || !isNumOnly(b)) return;
      var order = nameBelow ? [1, -1] : [-1, 1], nm = null;
      for (var o = 0; o < order.length && !nm; o++) {
        var nb = body[i + order[o]];
        if (nb && !nb.used && isTextOnly(nb)) { nm = nb; }
      }
      if (!nm) return;
      var it = build(nm.s.text, b.s.nums, b.line + ' ' + nm.line);
      if (it && b.s.fixed) it.flag = 'check';
      if (it && it.total > 0) { it.idx = Math.min(i, body.indexOf(nm)); out.items.push(it); b.used = true; nm.used = true; }
    });
    // keep the original reading order
    out.items.sort(function (x, y) { return x.idx - y.idx; });
    out.items.forEach(function (it) { delete it.idx; });

    // ---- reconcile ----
    var sum = r2(out.items.reduce(function (a, i) { return a + i.total; }, 0));
    if (!out.items.length) out.warnings.push('No item lines were recognised - please add the items by hand.');
    if (out.subtotal != null && out.vat != null) {
      var calc = r2(out.subtotal + out.vat);
      if (out.total == null) out.total = calc;
      else if (Math.abs(out.total - calc) > 1) { out.warnings.push('The total read from the photo (' + out.total.toFixed(2) + ') did not match subtotal + VAT, so ' + calc.toFixed(2) + ' is used - please check.'); out.total = calc; }
    }
    if (out.total == null) out.total = sum;
    if (out.items.length && Math.abs(out.total - sum) > Math.max(1, out.total * 0.02) && !(out.subtotal != null && Math.abs(out.subtotal - sum) <= 1)) {
      out.warnings.push('Items add up to ' + sum.toFixed(2) + ' but the invoice total reads ' + out.total.toFixed(2) + ' - check the lines.');
    }
    if (out.items.some(function (i) { return i.flag; })) out.warnings.push('Some lines look uncertain - please check quantities and prices.');
    return out;
  }

  /* ---------- match an invoice line to a catalogue product ---------- */
  var STOPWORDS = { pack: 1, pcs: 1, pc: 1, of: 1, the: 1, and: 1, ctn: 1, carton: 1 };
  function tokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (t) { return t && !STOPWORDS[t]; });
  }
  function matchProduct(desc, products) {
    var dt = tokens(desc), ds = dt.join(' '), best = null;
    if (!dt.length) return null;
    (products || []).forEach(function (p) {
      if (p.archived) return;
      var pt = tokens(p.name), ps = pt.join(' ');
      if (!pt.length) return;
      var score;
      if (p.code && dt.indexOf(String(p.code).toLowerCase()) >= 0) score = 1;
      else {
        var inter = dt.filter(function (t) { return pt.indexOf(t) >= 0; }).length;
        var union = dt.length + pt.length - inter;
        score = union ? inter / union : 0;
        if (ds === ps) score = 1;
        else if (ds.indexOf(ps) >= 0 || ps.indexOf(ds) >= 0) score = Math.max(score, 0.75);
      }
      if (!best || score > best.score) best = { id: p.id, score: score };
    });
    return best && best.score >= 0.5 ? best : null;
  }

  root.DogoInvoiceParse = { parse: parse, matchProduct: matchProduct, parseDate: parseDate, num: num };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DogoInvoiceParse;
})(typeof window !== 'undefined' ? window : globalThis);
