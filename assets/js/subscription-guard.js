/* Dogo POS - subscription guard (browser side).
   Asks the database for the business's subscription state (server clock, so changing the
   device date does nothing) and shows:
     - a warning card from 3 days before the plan ends, with a Renew button
     - a full-screen lock once the plan has ended
   The real lock is in the database (writes are refused once a plan has expired, see
   supabase/migrations/20261010_subscription_guard.sql); this file is the screen the user sees.
   Free plans never expire. The platform admin is never locked. */
(function () {
  'use strict';
  var DAY = 86400000;
  var CACHE_KEY = 'dogo_sub_state_v1:';
  var STYLE_ID = 'dogo-sub-style';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' }); }
    catch (e) { return String(iso || ''); }
  }

  // Work out expired / expiring from the renewal date and a given "now" (ms). Lets a cached
  // copy keep working offline and keeps the screen right if the page stays open past midnight.
  function derive(state, nowMs) {
    var s = {}; for (var k in state) s[k] = state[k];
    var plan = s.plan || 'Free';
    var renews = s.renews_at ? new Date(s.renews_at).getTime() : null;
    var paid = plan !== 'Free' && renews != null && !isNaN(renews);
    s.expired = !!(paid && renews < nowMs);
    s.expiring = !!(paid && !s.expired && renews - nowMs <= 3 * DAY);
    s.msLeft = paid ? renews - nowMs : null;
    s.days_left = paid ? Math.ceil((renews - nowMs) / DAY) : null;
    return s;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      '.dsg-bar{position:fixed;left:12px;right:12px;bottom:12px;margin:0 auto;max-width:620px;z-index:2147483000;display:flex;gap:10px;align-items:center;' +
      'padding:11px 12px 11px 14px;border-radius:14px;color:#1f2937;background:#fef3c7;border:1px solid #fcd34d;box-shadow:0 10px 30px rgba(0,0,0,.22);font:600 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.dsg-bar.dsg-urgent{background:#fee2e2;border-color:#fca5a5;color:#7f1d1d}' +
      '.dsg-bar .dsg-msg{flex:1;min-width:0}' +
      '.dsg-btn{border:0;border-radius:999px;padding:8px 16px;font:700 13px system-ui,sans-serif;cursor:pointer;background:#d97706;color:#fff;white-space:nowrap}' +
      '.dsg-urgent .dsg-btn{background:#dc2626}' +
      '.dsg-x{border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:inherit;opacity:.65;padding:2px 6px}' +
      '.dsg-lock{position:fixed;inset:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(15,23,42,.94);' +
      '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.dsg-card{width:100%;max-width:440px;background:#fff;color:#0f172a;border-radius:20px;padding:26px 24px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.45)}' +
      '.dsg-card h2{margin:6px 0 8px;font-size:22px;font-weight:800}' +
      '.dsg-card p{margin:0 0 12px;font-size:14px;line-height:1.5;color:#475569}' +
      '.dsg-ico{font-size:40px;line-height:1}' +
      '.dsg-note{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:12px;padding:10px 12px;font-size:13px;font-weight:600;margin:0 0 14px}' +
      '.dsg-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:6px}' +
      '.dsg-btn.dsg-big{padding:12px 24px;font-size:15px}' +
      '.dsg-btn.dsg-ghost{background:#e2e8f0;color:#0f172a}';
    document.head.appendChild(st);
  }

  function removeEl(id) { var el = document.getElementById(id); if (el && el.parentNode) el.parentNode.removeChild(el); }

  // legacy=1 keeps the signed-in user in the classic app, where the payment window lives
  // (plain index.html sends signed-in users straight back to dashboard.html)
  function renewUrl() { return 'index.html?legacy=1&renew=1'; }

  function showBanner(s, opts) {
    removeEl('dsg-bar');
    var skip = 'dogo_sub_banner_off:' + (s.renews_at || '');
    if (ssGet(skip) === '1') return;
    ensureStyles();
    var n = s.days_left;
    var when = s.msLeft < DAY ? 'in less than 24 hours' : 'in ' + n + ' day' + (n === 1 ? '' : 's');
    var bar = document.createElement('div');
    bar.id = 'dsg-bar';
    bar.className = 'dsg-bar' + (s.msLeft < DAY ? ' dsg-urgent' : '');
    bar.setAttribute('role', 'alert');
    bar.innerHTML =
      '<div class="dsg-msg">Your ' + esc(s.plan) + ' plan ends ' + when + ' (' + esc(fmtDate(s.renews_at)) + '). ' +
      (opts.isAdmin === false ? 'Ask your Admin to renew so Dogo POS does not lock.' : 'Renew now so Dogo POS does not lock.') + '</div>' +
      (opts.isAdmin === false ? '' : '<button class="dsg-btn" type="button" id="dsg-renew">Renew now</button>') +
      '<button class="dsg-x" type="button" id="dsg-dismiss" aria-label="Hide for now" title="Hide for now">&times;</button>';
    document.body.appendChild(bar);
    var r = document.getElementById('dsg-renew');
    if (r) r.onclick = function () { removeEl('dsg-bar'); renew(s, opts); };
    document.getElementById('dsg-dismiss').onclick = function () { ssSet(skip, '1'); removeEl('dsg-bar'); };
  }

  function renew(s, opts) {
    if (typeof opts.onRenew === 'function') { opts.onRenew(s); return; }
    location.href = renewUrl();
  }

  function showLock(s, opts, pending) {
    removeEl('dsg-bar');
    removeEl('dsg-lock');
    ensureStyles();
    var isAdmin = opts.isAdmin !== false;
    var wait = pending
      ? '<div class="dsg-note">We received your payment reference <strong>' + esc(pending.mpesa_code) + '</strong> on ' + esc(fmtDate(pending.created_at)) +
        ' and are verifying it. This screen unlocks as soon as it is approved.</div>'
      : '';
    var el = document.createElement('div');
    el.id = 'dsg-lock';
    el.className = 'dsg-lock';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<div class="dsg-card">' +
        '<div class="dsg-ico">&#128274;</div>' +
        '<h2>Your subscription has ended</h2>' +
        '<p>Your <strong>' + esc(s.plan) + '</strong> plan ended on <strong>' + esc(fmtDate(s.renews_at)) + '</strong>, so Dogo POS is locked. ' +
        'Your sales, stock and customers are safe and come back the moment you renew.</p>' +
        wait +
        (isAdmin
          ? '<div class="dsg-row"><button class="dsg-btn dsg-big" type="button" id="dsg-renew2">' + (pending ? 'Pay again / use another code' : 'Renew now') + '</button>' +
            '<button class="dsg-btn dsg-ghost dsg-big" type="button" id="dsg-recheck">I have paid - check again</button></div>'
          : '<p><strong>Please ask your business Admin to renew the subscription.</strong></p>' +
            '<div class="dsg-row"><button class="dsg-btn dsg-ghost dsg-big" type="button" id="dsg-recheck">Check again</button></div>') +
        '<div class="dsg-row" style="margin-top:12px"><button class="dsg-x" type="button" id="dsg-out" style="font-size:13px;text-decoration:underline">Sign out</button></div>' +
      '</div>';
    document.body.appendChild(el);
    try { document.documentElement.style.overflow = 'hidden'; } catch (e) {}
    var rn = document.getElementById('dsg-renew2');
    if (rn) rn.onclick = function () {
      // let the payment window sit above the lock screen, then bring the lock back if still unpaid
      el.style.display = 'none';
      renew(s, opts);
      var back = setInterval(function () {
        var m = document.getElementById('subUpgradeModalOverlay');
        var cs = m ? getComputedStyle(m) : null;
        var open = !!(cs && cs.display !== 'none' && cs.visibility !== 'hidden');
        if (!open) { clearInterval(back); check(opts.sb, opts); }   // window closed: re-read state (shows "we are verifying your payment")
      }, 600);
      // never leave the screen uncovered when there is no payment window on this page
      setTimeout(function () { if (!document.getElementById('subUpgradeModalOverlay')) { clearInterval(back); el.style.display = 'flex'; } }, 700);
    };
    document.getElementById('dsg-recheck').onclick = function () { location.reload(); };
    document.getElementById('dsg-out').onclick = function () {
      if (typeof opts.onLogout === 'function') opts.onLogout();
      else { try { opts.sb.auth.signOut({ scope: 'local' }).then(function () { location.href = 'index.html'; }); } catch (e) { location.href = 'index.html'; } }
    };
  }


  // ---- Pay-to-open lock: a paid plan was chosen at signup and has not been paid yet ----
  function showPayLock(s, opts) {
    removeEl('dsg-bar'); removeEl('dsg-lock'); ensureStyles();
    var isAdmin = opts.isAdmin !== false;
    var sb = opts.sb, plan = s.pending_plan, billing = s.pending_billing || 'monthly';
    var el = document.createElement('div');
    el.id = 'dsg-lock'; el.className = 'dsg-lock'; el.setAttribute('role', 'alertdialog');
    el.innerHTML =
      '<div class="dsg-card"><div class="dsg-ico">&#128241;</div>' +
      '<h2>Pay to open your account</h2>' +
      '<p>You chose the <strong>' + esc(plan) + '</strong> plan. Pay with M-Pesa and your account opens straight away.</p>' +
      (isAdmin
        ? '<input id="dsg-phone" type="tel" inputmode="numeric" placeholder="M-Pesa number e.g. 0712345678" style="width:100%;box-sizing:border-box;padding:13px;border:1px solid #cbd5e1;border-radius:12px;font-size:16px;margin:0 0 10px;text-align:center">' +
          '<div id="dsg-msg2" class="dsg-note" style="display:none"></div>' +
          '<div class="dsg-row"><button class="dsg-btn dsg-big" type="button" id="dsg-pay">Pay with M-Pesa</button></div>' +
          '<div class="dsg-row"><button class="dsg-btn dsg-ghost" type="button" id="dsg-free" style="font-size:12.5px;padding:8px 14px">Use the Free plan instead</button></div>'
        : '<p><strong>Please ask your business Admin to complete the payment.</strong></p>') +
      '<div class="dsg-row" style="margin-top:8px"><button class="dsg-x" type="button" id="dsg-out" style="font-size:13px;text-decoration:underline">Sign out</button></div></div>';
    document.body.appendChild(el);
    try { document.documentElement.style.overflow = 'hidden'; } catch (e) {}
    var msg = function (t, bad) { var m = document.getElementById('dsg-msg2'); if (!m) return; m.style.display = t ? 'block' : 'none'; m.textContent = t || ''; m.style.background = bad ? '#fee2e2' : '#ecfdf5'; m.style.color = bad ? '#7f1d1d' : '#065f46'; m.style.borderColor = bad ? '#fca5a5' : '#a7f3d0'; };
    var out = document.getElementById('dsg-out');
    out.onclick = function () { try { sb.auth.signOut({ scope: 'local' }).then(function () { location.href = 'index.html'; }); } catch (e) { location.href = 'index.html'; } };
    var pay = document.getElementById('dsg-pay');
    if (!pay) return;
    var polling = false;
    pay.onclick = async function () {
      var phone = (document.getElementById('dsg-phone').value || '').trim();
      if (!phone) { msg('Enter the M-Pesa number to charge.', true); return; }
      pay.disabled = true; pay.textContent = 'Sending prompt...'; msg('');
      try {
        var r = await sb.functions.invoke('sub-stk-push', { body: { plan: plan, billing: billing, phone: phone } });
        var d = r.data || {};
        if (r.error && !d.payment_id) {
          var em = d.error; try { if (!em && r.error.context && r.error.context.json) { var j = await r.error.context.json(); em = j.error; if (j.payment_id) d = j; } } catch (e) {}
          if (!d.payment_id) { msg(em || 'Could not start the payment. Try again.', true); pay.disabled = false; pay.textContent = 'Pay with M-Pesa'; return; }
        }
        if (d.error && !d.payment_id) { msg(d.error, true); pay.disabled = false; pay.textContent = 'Pay with M-Pesa'; return; }
        msg('Check your phone and enter your M-Pesa PIN. Amount: KES ' + (d.amount || '') + '.');
        pay.textContent = 'Waiting for payment...';
        var tries = 0;
        var t = setInterval(async function () {
          if (polling) return; polling = true; tries++;
          try {
            var q = await sb.functions.invoke('sub-stk-status', { body: { payment_id: d.payment_id } });
            var st = q.data && q.data.status;
            if (st === 'paid') { clearInterval(t); msg('Payment received. Opening your account...'); setTimeout(function () { location.reload(); }, 900); }
            else if (st && st !== 'pending') { clearInterval(t); msg((q.data.message || 'The payment did not go through') + '. Try again.', true); pay.disabled = false; pay.textContent = 'Pay with M-Pesa'; }
          } catch (e) {}
          polling = false;
          if (tries > 80) { clearInterval(t); pay.disabled = false; pay.textContent = 'Pay with M-Pesa'; msg('We did not get a confirmation. If you paid, wait a minute and reload.', true); }
        }, 3000);
      } catch (e) { msg('Network problem. Try again.', true); pay.disabled = false; pay.textContent = 'Pay with M-Pesa'; }
    };
    var fr = document.getElementById('dsg-free');
    if (fr) fr.onclick = async function () {
      if (!confirm('Switch to the Free plan (up to 5 products, 1 branch)?')) return;
      try { var r = await sb.rpc('cancel_pending_plan'); if (r.error) throw r.error; location.reload(); } catch (e) { msg('Could not switch: ' + (e.message || e), true); }
    };
  }

  function unlock() {
    removeEl('dsg-lock');
    try { document.documentElement.style.overflow = ''; } catch (e) {}
  }

  async function fetchState(sb, key) {
    try {
      var res = await sb.rpc('subscription_state');
      if (res.error || !res.data) throw (res.error || new Error('empty state'));
      var data = res.data;
      lsSet(CACHE_KEY + key, { state: data, savedAt: Date.now() });
      // trust the server clock, not the device clock
      var serverNow = data.now ? new Date(data.now).getTime() : Date.now();
      return { state: derive(data, isNaN(serverNow) ? Date.now() : serverNow), online: true };
    } catch (e) {
      var c = lsGet(CACHE_KEY + key);
      if (c && c.state) return { state: derive(c.state, Date.now()), online: false };
      return null;
    }
  }

  async function pendingClaim(sb) {
    try {
      var r = await sb.from('subscription_claims').select('plan,mpesa_code,created_at').eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(1);
      return r && r.data && r.data[0] ? r.data[0] : null;
    } catch (e) { return null; }
  }

  var pollTimer = null;
  async function check(sb, opts) {
    opts = opts || {};
    opts.sb = sb;
    var key = opts.key || 'default';
    var got = await fetchState(sb, key);
    if (!got) return null;
    var s = got.state;
    if (s.bypass) { unlock(); removeEl('dsg-bar'); return s; }   // platform admin: never locked

    if (s.pending_plan && !s.expired) { showPayLock(s, opts); return s; }

    if (s.expired) {
      var p = got.online ? await pendingClaim(sb) : null;
      showLock(s, opts, p);
      if (opts.autoRenew && opts.isAdmin !== false && typeof opts.onRenew === 'function') { opts.autoRenew = false; var lk = document.getElementById('dsg-renew2'); if (lk) lk.click(); }
      // while locked, look for approval every minute and reload when it comes through
      if (!pollTimer) pollTimer = setInterval(async function () {
        var again = await fetchState(sb, key);
        if (again && again.online && !again.state.expired) { clearInterval(pollTimer); pollTimer = null; location.reload(); }
      }, 60000);
    } else {
      unlock();
      if (s.expiring) {
        showBanner(s, opts);
        if (opts.autoRenew && opts.isAdmin !== false) { opts.autoRenew = false; renew(s, opts); }
      } else removeEl('dsg-bar');
    }
    return s;
  }

  window.DogoSubGuard = { check: check, derive: derive, renewUrl: renewUrl };
})();
