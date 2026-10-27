/* Dogo POS — real device support: thermal receipt printers, cash drawers and barcode scanners.

   Printing (choose per device in Settings > Hardware):
     bluetooth  Web Bluetooth to an ESC/POS thermal printer (Chrome on Android / desktop)
     usb        WebUSB to a USB ESC/POS printer (Chrome on Android / desktop; permission is remembered)
     rawbt      hands the receipt to the RawBT Android app (works with any printer RawBT can reach)
     browser    the normal print dialog (A4, or a 58/80 mm "paper" size) - the fallback everywhere
   Cash drawer: the standard ESC/POS "kick" pulse sent through the receipt printer's drawer port.
   Scanners: USB/Bluetooth scanners that act as a keyboard are recognised anywhere on the page (fast
   keystrokes ending in Enter); the camera scanner stays in the till as before.

   Pure functions (ESC/POS building) have no network or browser dependency, so they also run in tests.
   Settings are per device (localStorage), because the printer is plugged into one device. */
(function (root) {
  'use strict';

  var ESC = 0x1b, GS = 0x1d, LF = 0x0a;

  /* ---------- text helpers ---------- */
  var MAP = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '×': 'x', ' ': ' ', '€': 'EUR' };
  function ascii(s) {
    return String(s == null ? '' : s).replace(/[^\x00-\x7f]/g, function (c) { return MAP[c] || '?'; });
  }
  function money(n) {
    return Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function wrap(s, w) {
    var out = [], words = ascii(s).split(/\s+/), cur = '';
    words.forEach(function (word) {
      while (word.length > w) { if (cur) { out.push(cur); cur = ''; } out.push(word.slice(0, w)); word = word.slice(w); }
      if (!cur) cur = word;
      else if ((cur + ' ' + word).length <= w) cur += ' ' + word;
      else { out.push(cur); cur = word; }
    });
    if (cur) out.push(cur);
    return out.length ? out : [''];
  }
  function lr(left, right, w) {      // left text, right text, padded to the paper width
    left = ascii(left); right = ascii(right);
    var gap = w - left.length - right.length;
    if (gap < 1) { left = left.slice(0, Math.max(0, w - right.length - 1)); gap = Math.max(1, w - left.length - right.length); }
    return left + new Array(gap + 1).join(' ') + right;
  }

  /* ---------- ESC/POS encoder ---------- */
  function Encoder(width) {
    this.w = width || 32;          // characters per line: 32 = 58 mm, 48 = 80 mm
    this.b = [];
  }
  Encoder.prototype = {
    raw: function () { for (var i = 0; i < arguments.length; i++) this.b.push(arguments[i] & 255); return this; },
    init: function () { return this.raw(ESC, 0x40); },
    align: function (a) { return this.raw(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0); },
    bold: function (on) { return this.raw(ESC, 0x45, on ? 1 : 0); },
    size: function (n) { return this.raw(GS, 0x21, n); },               // 0 normal, 0x11 double w+h, 0x01 double height
    text: function (s) { s = ascii(s); for (var i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) & 255); return this; },
    line: function (s) { return this.text(s || '').raw(LF); },
    feed: function (n) { return this.raw(ESC, 0x64, n == null ? 3 : n); },
    rule: function (ch) { return this.line(new Array(this.w + 1).join(ch || '-')); },
    cut: function () { return this.raw(GS, 0x56, 0x42, 0x00); },        // feed to cut position, partial cut
    drawer: function () { return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa); },   // pulse pin 2 (the common drawer wiring)
    barcode128: function (code) {
      code = ascii(code).slice(0, 40); if (!code) return this;
      this.raw(GS, 0x68, 60, GS, 0x77, 2, GS, 0x48, 2);                   // height 60, width 2, number below
      this.raw(GS, 0x6b, 73, code.length + 2, 0x7b, 0x42);                // Code 128, subset B
      return this.text(code).raw(LF);
    },
    qr: function (data, size) {
      data = ascii(data); if (!data) return this;
      var n = data.length + 3;
      this.raw(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0);                      // model 2
      this.raw(GS, 0x28, 0x6b, 3, 0, 49, 67, size || 6);                 // module size
      this.raw(GS, 0x28, 0x6b, 3, 0, 49, 69, 49);                         // error correction M
      this.raw(GS, 0x28, 0x6b, n & 255, (n >> 8) & 255, 49, 80, 48);     // store
      this.text(data);
      return this.raw(GS, 0x28, 0x6b, 3, 0, 49, 81, 48).raw(LF);          // print
    },
    bytes: function () { return new Uint8Array(this.b); }
  };

  /* opts: business, profile, receiptNo, items[{name,qty,price,vat(fraction),unit}], grand, now, mpesaReceipt,
           gatewayName, tendered, orderLine, width (32|48), openDrawer, title, qr (eTIMS QR text), barcode (false to skip),
           extra {till, store} */
  function buildReceipt(opts) {
    var w = Number(opts.width) === 48 ? 48 : 32;
    var e = new Encoder(w), b = opts.business || {}, items = opts.items || [], now = opts.now || new Date();
    var extra = opts.extra || {};
    var showVat = b.receipt_show_vat_breakdown !== false;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var d = pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear() + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

    e.init();
    if (opts.openDrawer) e.drawer();
    e.align('center').bold(true).size(0x11);
    wrap(b.name || '', Math.floor(w / 2)).forEach(function (l) { e.line(l); });
    e.size(0).bold(false);
    if (b.location) e.line(b.location);
    if (b.receipt_phone) e.line('TEL: ' + b.receipt_phone);
    if (b.kra_pin) e.line('PIN: ' + b.kra_pin);
    if (extra.till) e.bold(true).line('BUY GOODS TILL NO: ' + extra.till).bold(false);
    if (opts.title) e.bold(true).line(opts.title).bold(false);
    if (opts.orderLine) e.bold(true).line(opts.orderLine).bold(false);
    e.align('left').line(lr(d, '#' + String(opts.receiptNo || '').replace(/^RC-/, ''), w));
    if (opts.profile && opts.profile.full_name) e.line('Served by: ' + String(opts.profile.full_name).toUpperCase());
    e.rule('-');

    var sub = 0, vat = 0, grand = 0;
    items.forEach(function (it) {
      var rate = Number(it.vat) || 0, qty = Number(it.qty) || 0, price = Number(it.price) || 0;
      var lineTotal = it.line_total != null ? Number(it.line_total) : price * qty;
      var ext = lineTotal / (1 + rate);
      sub += ext; vat += lineTotal - ext; grand += lineTotal;
      wrap(String(it.name || '').toUpperCase(), w).forEach(function (l) { e.line(l); });
      var unit = it.unit && it.unit !== 'piece' ? ' ' + it.unit : '';
      e.line(lr('  ' + qty + unit + ' x ' + money(price), money(lineTotal), w));
    });
    if (opts.grand != null && isFinite(opts.grand)) grand = Number(opts.grand);
    e.rule('-');
    if (showVat) {
      e.line(lr('Subtotal', money(sub), w));
      e.line(lr('VAT included', money(vat), w));
    }
    e.bold(true).size(0x01).line(lr('TOTAL', 'KSH ' + money(grand), w)).size(0).bold(false);
    var tendered = Number(opts.tendered) || 0;
    if (opts.mpesaReceipt) e.line(lr((opts.gatewayName || 'M-Pesa') + ' Ref', opts.mpesaReceipt, w));
    else if (tendered >= grand && tendered > 0) {
      e.line(lr('Cash tendered', money(tendered), w));
      e.line(lr('Change', money(tendered - grand), w));
    }
    e.rule('-').align('center');
    if (opts.qr) e.line('Scan to verify (KRA eTIMS)').qr(opts.qr, 5);
    var footer = b.receipt_footer && b.receipt_footer !== 'Thank you for your business!' ? b.receipt_footer : 'Thank you for shopping with us';
    wrap(footer, w).forEach(function (l) { e.line(l); });
    if (opts.barcode !== false && extra.barcode !== false && opts.receiptNo) e.feed(1).barcode128(String(opts.receiptNo));
    e.feed(3).cut();
    return e.bytes();
  }

  /* ---------- settings (per device) ---------- */
  var DEFAULTS = { mode: 'browser', paper: 58, autoPrint: false, drawer: false, btName: '', usbName: '', scanner: true,
    devId: '', devVendor: 0, devProduct: 0, bleService: '', bleChar: '' };
  var KEY = 'dogo_hardware_v1';
  var mem = {};      // used when the browser blocks localStorage (private window), so settings still hold for this visit
  function getSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { s = {}; }
    var out = {};
    for (var k in DEFAULTS) out[k] = mem[k] !== undefined ? mem[k] : (s[k] !== undefined ? s[k] : DEFAULTS[k]);
    return out;
  }
  function setSettings(patch) {
    for (var k in patch) mem[k] = patch[k];
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { s = {}; }
    for (var j in patch) s[j] = patch[j];
    try { localStorage.setItem(KEY, JSON.stringify(s)); return true; } catch (e) { return false; }
  }

  /* ---------- transports ---------- */
  var BT_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '49535343-fe7d-4ae5-8fa9-9fafd205e455', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb'];
  var bt = { device: null, char: null }, usb = { device: null, ep: null, iface: null };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function btFindChar(device) {
    var server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    var services = await server.getPrimaryServices();
    for (var i = 0; i < services.length; i++) {
      var chars = await services[i].getCharacteristics();
      for (var j = 0; j < chars.length; j++) {
        var p = chars[j].properties;
        if (p.write || p.writeWithoutResponse) return chars[j];
      }
    }
    throw new Error('No writable printer channel found on this Bluetooth device.');
  }
  async function btPair() {
    if (!root.navigator || !navigator.bluetooth) throw new Error('This browser has no Bluetooth printing. Use Chrome on Android, or choose USB, RawBT or Browser print.');
    var dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BT_SERVICES });
    bt.device = dev; bt.char = await btFindChar(dev);
    setSettings({ mode: 'bluetooth', btName: dev.name || 'Bluetooth printer' });
    return dev.name || 'Bluetooth printer';
  }
  async function btSend(bytes) {
    if (!bt.device) {
      // Chrome can hand back a printer it already paired with (needs the "getDevices" feature); otherwise pair again.
      if (navigator.bluetooth && navigator.bluetooth.getDevices) {
        var known = await navigator.bluetooth.getDevices(), want = getSettings().btName;
        bt.device = known.filter(function (d) { return !want || d.name === want; })[0] || null;
      }
      if (!bt.device) throw new Error('Printer not connected. Open Settings > Hardware and tap Pair printer.');
    }
    if (!bt.char || !bt.device.gatt.connected) bt.char = await btFindChar(bt.device);
    var noResp = bt.char.properties.writeWithoutResponse;
    for (var i = 0; i < bytes.length; i += 100) {
      var chunk = bytes.slice(i, i + 100);
      if (noResp && bt.char.writeValueWithoutResponse) await bt.char.writeValueWithoutResponse(chunk);
      else await bt.char.writeValue(chunk);
      await sleep(20);
    }
  }

  async function usbOpen(device) {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    var found = null;
    (device.configuration.interfaces || []).forEach(function (itf) {
      (itf.alternates || []).forEach(function (alt) {
        (alt.endpoints || []).forEach(function (ep) {
          if (ep.direction !== 'out' || ep.type !== 'bulk') return;
          // prefer the standard printer class (7); otherwise take the first bulk-out channel
          if (!found || (alt.interfaceClass === 7 && !found.printer)) found = { itf: itf.interfaceNumber, ep: ep.endpointNumber, printer: alt.interfaceClass === 7 };
        });
      });
    });
    if (!found) throw new Error('This USB device has no printer output channel.');
    await device.claimInterface(found.itf);
    usb.device = device; usb.ep = found.ep; usb.iface = found.itf;
  }
  async function usbPair() {
    if (!root.navigator || !navigator.usb) throw new Error('This browser has no USB printing. Use Chrome, or choose Bluetooth, RawBT or Browser print.');
    var dev = await navigator.usb.requestDevice({ filters: [] });
    await usbOpen(dev);
    setSettings({ mode: 'usb', usbName: dev.productName || 'USB printer' });
    return dev.productName || 'USB printer';
  }
  async function usbSend(bytes) {
    if (!usb.device) {
      var list = await navigator.usb.getDevices();
      if (!list.length) throw new Error('USB printer not connected. Open Settings > Hardware and tap Pair printer.');
      await usbOpen(list[0]);
    }
    for (var i = 0; i < bytes.length; i += 4096) await usb.device.transferOut(usb.ep, bytes.slice(i, i + 4096));
  }


  /* ---------- Android app (Capacitor): native Bluetooth, Bluetooth LE and USB ----------
     Web Bluetooth / WebUSB do not exist inside the Android app's WebView, so the same ESC/POS bytes go through
     native plugins instead (DogoPrinter = classic Bluetooth + USB, BluetoothLe = low-energy printers). */
  function cap() { return root.Capacitor && root.Capacitor.isNativePlatform && root.Capacitor.isNativePlatform() ? root.Capacitor : null; }
  function plug(name) {
    var c = cap();
    if (!c || !c.Plugins || !c.Plugins[name]) throw new Error('This feature needs the Dogo POS Android app (update to the latest version).');
    return c.Plugins[name];
  }
  function toHex(bytes) { var h = ''; for (var i = 0; i < bytes.length; i++) h += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return h; }
  function errText(e) { return e && e.message ? e.message : String(e); }

  // Small pick-a-device dialog (the paired Bluetooth or USB printers found on this device)
  function choose(title, items) {
    return new Promise(function (resolve, reject) {
      if (items.length === 1) return resolve(items[0]);
      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';
      var box = document.createElement('div');
      box.style.cssText = 'background:#fff;color:#111;border-radius:14px;max-width:360px;width:100%;padding:18px;font-family:inherit;';
      var h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-weight:700;margin-bottom:10px;';
      box.appendChild(h);
      items.forEach(function (it) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = it.name;
        b.style.cssText = 'display:block;width:100%;text-align:left;padding:12px;margin:6px 0;border:1px solid #d1d5db;border-radius:10px;background:#f9fafb;font-size:15px;';
        b.onclick = function () { document.body.removeChild(wrap); resolve(it); };
        box.appendChild(b);
      });
      var c = document.createElement('button'); c.type = 'button'; c.textContent = 'Cancel';
      c.style.cssText = 'display:block;width:100%;padding:10px;margin-top:8px;border:0;background:none;color:#6b7280;font-size:14px;';
      c.onclick = function () { document.body.removeChild(wrap); var e = new Error('No printer was chosen.'); e.name = 'NotFoundError'; reject(e); };
      box.appendChild(c); wrap.appendChild(box); document.body.appendChild(wrap);
    });
  }

  // classic Bluetooth (most 58/80 mm thermal printers) - pair the printer in Android Bluetooth settings first
  async function nbtPair() {
    var r = await plug('DogoPrinter').btList();
    if (!r.devices.length) throw new Error('No paired Bluetooth devices. Turn the printer on, pair it in Android Settings > Bluetooth (PIN is usually 0000 or 1234), then try again.');
    var d = await choose('Choose your printer', r.devices);
    setSettings({ mode: 'native-bt', btName: d.name, devId: d.address });
    return d.name;
  }
  async function nbtSend(bytes) {
    var id = getSettings().devId;
    if (!id) throw new Error('Printer not set up. Open Settings > Hardware and tap Pair printer.');
    await plug('DogoPrinter').btWrite({ address: id, data: toBase64(bytes) });
  }

  // Bluetooth Low Energy printers
  async function bleInit() { await plug('BluetoothLe').initialize({ androidNeverForLocation: true }); }
  async function bleFindChar(deviceId) {
    var r = await plug('BluetoothLe').getServices({ deviceId: deviceId }), best = null;
    (r.services || []).forEach(function (svc) {
      (svc.characteristics || []).forEach(function (ch) {
        var p = ch.properties || {};
        if (!(p.write || p.writeWithoutResponse)) return;
        if (!best || (p.writeWithoutResponse && !best.noResp)) best = { service: svc.uuid, char: ch.uuid, noResp: !!p.writeWithoutResponse };
      });
    });
    if (!best) throw new Error('No writable printer channel found on this Bluetooth device.');
    return best;
  }
  async function nblePair() {
    await bleInit();
    var dev = await plug('BluetoothLe').requestDevice({ optionalServices: BT_SERVICES });
    await plug('BluetoothLe').connect({ deviceId: dev.deviceId });
    var c = await bleFindChar(dev.deviceId);
    setSettings({ mode: 'native-ble', btName: dev.name || 'Bluetooth printer', devId: dev.deviceId, bleService: c.service, bleChar: c.char });
    return dev.name || 'Bluetooth printer';
  }
  async function nbleSend(bytes) {
    var s = getSettings(), L = plug('BluetoothLe');
    if (!s.devId) throw new Error('Printer not set up. Open Settings > Hardware and tap Pair printer.');
    await bleInit();
    try { await L.connect({ deviceId: s.devId }); } catch (e) { throw new Error('Could not reach the printer. Check it is on and in range, or pair it again.'); }
    var svc = s.bleService, ch = s.bleChar;
    if (!svc || !ch) { var f = await bleFindChar(s.devId); svc = f.service; ch = f.char; setSettings({ bleService: svc, bleChar: ch }); }
    for (var i = 0; i < bytes.length; i += 100) {
      var arg = { deviceId: s.devId, service: svc, characteristic: ch, value: toHex(bytes.slice(i, i + 100)) };
      try { await L.writeWithoutResponse(arg); } catch (e) { await L.write(arg); }
      await sleep(20);
    }
  }

  // USB (OTG cable)
  async function nusbPair() {
    var r = await plug('DogoPrinter').usbList();
    if (!r.devices.length) throw new Error('No USB printer found. Plug the printer in with the OTG cable and try again.');
    var d = await choose('Choose your USB printer', r.devices);
    setSettings({ mode: 'native-usb', usbName: d.name, devId: d.id, devVendor: d.vendorId, devProduct: d.productId });
    return d.name;
  }
  async function nusbSend(bytes) {
    var s = getSettings(), P = plug('DogoPrinter');
    var r = await P.usbList(), id = null;           // the device path changes when the cable is replugged: match on vendor/product
    r.devices.forEach(function (d) { if (!id && d.vendorId === s.devVendor && d.productId === s.devProduct) id = d.id; });
    if (!id) throw new Error('USB printer not connected. Plug it in, or open Settings > Hardware and tap Pair printer.');
    await P.usbWrite({ id: id, data: toBase64(bytes) });
  }

  function toBase64(bytes) {
    var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function rawbtSend(bytes) { root.location.href = 'rawbt:base64,' + toBase64(bytes); return Promise.resolve(); }

  async function send(bytes) {
    var mode = getSettings().mode;
    if (mode === 'bluetooth') return btSend(bytes);
    if (mode === 'usb') return usbSend(bytes);
    if (mode === 'rawbt') return rawbtSend(bytes);
    if (mode === 'native-bt') return nbtSend(bytes);
    if (mode === 'native-ble') return nbleSend(bytes);
    if (mode === 'native-usb') return nusbSend(bytes);
    throw new Error('NO_RAW_PRINTER');
  }

  /* ---------- public actions ---------- */
  function width() { return getSettings().paper === 80 ? 48 : 32; }

  async function printReceipt(opts) {
    var s = getSettings();
    opts = Object.assign({ width: width(), openDrawer: s.drawer && opts && opts.payMethod === 'cash' }, opts || {});
    if (s.mode === 'browser' && cap()) return { ok: false, via: 'browser', error: 'No printer set up on this device. Open Settings > Hardware, choose your printer and tap Pair printer.' };
    if (s.mode === 'browser') { if (root.print) root.print(); return { ok: true, via: 'browser' }; }
    try {
      await send(buildReceipt(opts));
      return { ok: true, via: s.mode };
    } catch (err) {
      return { ok: false, via: s.mode, error: err && err.message ? err.message : String(err) };
    }
  }
  async function openDrawer() {
    var s = getSettings();
    if (s.mode === 'browser') return { ok: false, error: 'A cash drawer needs a receipt printer connected by Bluetooth or USB.' };
    try { await send(new Encoder(width()).init().drawer().bytes()); return { ok: true }; }
    catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  }
  async function testPrint() {
    var b = { name: 'Dogo POS', location: 'Printer test', kra_pin: '' };
    return printReceipt({ business: b, receiptNo: 'RC-TEST', title: 'TEST PRINT', items: [
      { name: 'Test item', qty: 2, price: 150, vat: 0.16, unit: 'piece' }, { name: 'Second item with a long name to check wrapping', qty: 1, price: 75.5, vat: 0 }],
      tendered: 500, openDrawer: false, barcode: true });
  }
  async function pair() {
    var mode = getSettings().mode;
    if (mode === 'native-bt') return nbtPair();
    if (mode === 'native-ble') return nblePair();
    if (mode === 'native-usb') return nusbPair();
    if (mode === 'usb') return usbPair();
    return btPair();
  }
  function supports() {
    var nav = root.navigator || {};
    return { bluetooth: !!nav.bluetooth, usb: !!nav.usb, rawbt: /android/i.test(nav.userAgent || ''), browser: true, native: !!cap() };
  }

  /* ---------- keyboard-wedge scanner ---------- */
  var scanCleanup = null;
  function listenScans(cb, opts) {
    if (scanCleanup) scanCleanup();
    opts = opts || {};
    var maxGap = opts.maxGap || 60, minLen = opts.minLen || 4, buf = '', last = 0, fast = 0;
    function onKey(e) {
      if (!getSettings().scanner) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) { buf = ''; return; }
      var now = Date.now();
      if (e.key === 'Enter') {
        if (buf.length >= minLen && fast >= buf.length - 1) { var code = buf; buf = ''; fast = 0; e.preventDefault(); cb(code); return; }
        buf = ''; fast = 0; return;
      }
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (now - last > maxGap) { buf = ''; fast = 0; }
        else fast++;
        buf += e.key; last = now;
      }
    }
    document.addEventListener('keydown', onKey, true);
    scanCleanup = function () { document.removeEventListener('keydown', onKey, true); scanCleanup = null; };
    return scanCleanup;
  }


  /* ---------- Android app: native camera barcode scanner (Google ML Kit, works offline) ---------- */
  async function nativeScan() {
    var B = plug('BarcodeScanner');
    try {
      var av = await B.isGoogleBarcodeScannerModuleAvailable();
      if (av && av.available === false) await B.installGoogleBarcodeScannerModule();
    } catch (e) { /* older Play services: scan() will report the real problem */ }
    var r = await B.scan({ formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'QR_CODE'] });
    var b = r && r.barcodes && r.barcodes[0];
    return b ? (b.rawValue || b.displayValue || '') : '';
  }

  root.DogoHardware = {
    Encoder: Encoder, buildReceipt: buildReceipt, getSettings: getSettings, setSettings: setSettings,
    pair: pair, printReceipt: printReceipt, testPrint: testPrint, openDrawer: openDrawer, supports: supports,
    listenScans: listenScans, nativeScan: nativeScan, _internals: { wrap: wrap, lr: lr, ascii: ascii, toBase64: toBase64 }
  };
})(typeof window !== 'undefined' ? window : globalThis);
