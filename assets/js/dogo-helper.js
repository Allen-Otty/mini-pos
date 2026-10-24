/* Dogo Helper — floating AI assistant.
   Landing page / signed-out: product help bot.  Signed-in shop: "Help" + "My shop" (answers from that shop's own data).
   Talks to the ai-assistant edge function; the AI key never reaches the browser. */
(function () {
  if (window.__dogoHelper) return; window.__dogoHelper = true;
  if (/\/admin\//.test(location.pathname)) return;
  var URL_ = 'https://uzwomzkzqrpiumtnniik.supabase.co';
  var ANON = 'sb_publishable_wt1aY_uj1ZR4z5RqIgDZQw_qYNoCl7D';
  var TOKEN_KEY = 'sb-uzwomzkzqrpiumtnniik-auth-token';
  var hist = { help: [], business: [] };
  var tab = 'help', open = false, busy = false, unavailable = false;

  function token() {
    try { var t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); return t && t.access_token && (t.expires_at ? t.expires_at * 1000 > Date.now() : true) ? t.access_token : null; } catch (e) { return null; }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function md(t) {
    var h = esc(t);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/(^|\n)#{1,4} ?([^\n]+)/g, '$1<b>$2</b>').replace(/(^|\n)[-*•] +([^\n]+)/g, '$1• $2');
    return h.replace(/\n/g, '<br>');
  }

  var css = '#dgh-fab{position:fixed;right:16px;bottom:16px;z-index:99990;width:54px;height:54px;border-radius:50%;border:0;cursor:pointer;background:#16a34a;color:#fff;font-size:22px;box-shadow:0 6px 20px rgba(0,0,0,.28)}' +
    '#dgh-fab:hover{background:#15803d}' +
    '#dgh{position:fixed;right:16px;bottom:80px;z-index:99991;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 100px);background:#fff;color:#0f172a;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font:14px/1.45 "Instrument Sans",system-ui,sans-serif}' +
    '#dgh.on{display:flex}' +
    '#dgh header{background:#0A2A14;color:#fff;padding:10px 12px;display:flex;align-items:center;gap:8px}' +
    '#dgh header b{flex:1;font-size:14px}#dgh header button{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}' +
    '#dgh .tabs{display:flex;background:#0f3d1d}#dgh .tabs button{flex:1;padding:7px;border:0;background:none;color:#cfe8d6;cursor:pointer;font-size:12.5px;font-weight:600}#dgh .tabs button.on{color:#fff;box-shadow:inset 0 -2px #4ade80}' +
    '#dgh .msgs{flex:1;overflow-y:auto;padding:12px;background:#f6f8f7}' +
    '#dgh .m{max-width:88%;padding:8px 11px;border-radius:12px;margin:0 0 8px;word-wrap:break-word}' +
    '#dgh .m.u{background:#16a34a;color:#fff;margin-left:auto;border-bottom-right-radius:4px}#dgh .m.b{background:#fff;border:1px solid #e2e8f0;border-bottom-left-radius:4px}' +
    '#dgh .m code{background:#eef2f0;padding:1px 5px;border-radius:4px}' +
    '#dgh .chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px}#dgh .chips button{border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer}' +
    '#dgh form{display:flex;gap:6px;padding:8px;border-top:1px solid #e2e8f0;background:#fff}' +
    '#dgh input{flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:9px 10px;font:inherit;min-width:0}#dgh form button{background:#16a34a;color:#fff;border:0;border-radius:10px;padding:0 14px;cursor:pointer;font-weight:700}' +
    '@media print{#dgh,#dgh-fab{display:none!important}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var fab = document.createElement('button'); fab.id = 'dgh-fab'; fab.setAttribute('aria-label', 'Ask Dogo Helper'); fab.innerHTML = '💬';
  var box = document.createElement('div'); box.id = 'dgh';
  box.innerHTML = '<header><b>Dogo Helper</b><button type="button" aria-label="Close">×</button></header><div class="tabs"></div><div class="msgs"></div>' +
    '<form><input placeholder="Ask anything about Dogo…" aria-label="Your question" maxlength="500"><button>Send</button></form>';
  document.body.appendChild(fab); document.body.appendChild(box);
  var msgs = box.querySelector('.msgs'), input = box.querySelector('input'), tabs = box.querySelector('.tabs');

  var CHIPS = {
    help: ['What does Dogo cost?', 'Does it work offline?', 'How do I print receipts?', 'Can it do KRA eTIMS?'],
    business: ['How did I do today?', 'What is running low?', 'What sells best this month?', 'How much came in by M-Pesa vs cash?']
  };

  function add(cls, html) { var d = document.createElement('div'); d.className = 'm ' + cls; d.innerHTML = html; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; }
  function renderTabs() {
    var signed = !!token();
    tabs.style.display = signed ? 'flex' : 'none';
    tabs.innerHTML = signed ? '<button class="' + (tab === 'help' ? 'on' : '') + '" data-t="help">Help</button><button class="' + (tab === 'business' ? 'on' : '') + '" data-t="business">My shop</button>' : '';
    if (!signed && tab === 'business') tab = 'help';
  }
  function renderChat() {
    renderTabs(); msgs.innerHTML = '';
    add('b', tab === 'business' ? 'Hi! I can read <b>your shop\'s</b> numbers and help you act on them. What would you like to know?' :
      'Hi 👋 I\'m the Dogo helper. Ask me about features, pricing, setup or troubleshooting.');
    hist[tab].forEach(function (m) { add(m.role === 'user' ? 'u' : 'b', m.role === 'user' ? esc(m.content) : md(m.content)); });
    if (!hist[tab].length) {
      var c = document.createElement('div'); c.className = 'chips';
      CHIPS[tab].forEach(function (q) { var b = document.createElement('button'); b.type = 'button'; b.textContent = q; b.onclick = function () { send(q); }; c.appendChild(b); });
      msgs.appendChild(c);
    }
    input.placeholder = tab === 'business' ? 'Ask about your sales, stock, staff…' : 'Ask anything about Dogo…';
  }

  async function send(text) {
    text = (text || '').trim(); if (!text || busy) return;
    busy = true; input.value = '';
    hist[tab].push({ role: 'user', content: text }); renderChat();
    var wait = add('b', '…');
    var mode = tab;
    try {
      var headers = { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + (mode === 'business' ? token() : ANON) };
      var r = await fetch(URL_ + '/functions/v1/ai-assistant', { method: 'POST', headers: headers,
        body: JSON.stringify({ mode: mode, messages: hist[mode], page: location.pathname.split('/').pop() || 'home' }) });
      var d = await r.json().catch(function () { return {}; });
      if (r.ok && d.reply) { hist[mode].push({ role: 'assistant', content: d.reply }); wait.innerHTML = md(d.reply); }
      else {
        hist[mode].pop();
        wait.innerHTML = d.error === 'ai_not_configured' || d.error === 'ai_disabled'
          ? 'The AI helper isn\'t switched on yet. Please check the FAQ or WhatsApp us.'
          : esc(d.message || d.error || 'Sorry, I could not answer just now.') + '';
      }
    } catch (e) {
      hist[mode].pop(); wait.innerHTML = 'You seem to be offline — the helper needs internet.';
    }
    busy = false; msgs.scrollTop = msgs.scrollHeight;
  }

  fab.onclick = function () { open = !open; box.classList.toggle('on', open); if (open) { renderChat(); input.focus(); } };
  box.querySelector('header button').onclick = function () { open = false; box.classList.remove('on'); };
  tabs.onclick = function (e) { var t = e.target.getAttribute && e.target.getAttribute('data-t'); if (t) { tab = t; renderChat(); } };
  box.querySelector('form').onsubmit = function (e) { e.preventDefault(); send(input.value); };
})();
