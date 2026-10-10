/* Dogo POS — landing page CMS.
   Public visitors: applies saved edits (text, images, links, hidden blocks, banner) from the
   landing_content table on top of the built-in page. Platform admins: index.html?cms=edit turns
   the landing page into a click-to-edit canvas. Edits are keyed by each element's position in
   the page, so they survive redeploys as long as the page structure doesn't change. If the table
   is missing or the network is down, the built-in page is shown untouched. */
(function () {
  const URL_ = 'https://uzwomzkzqrpiumtnniik.supabase.co';
  const KEY_ = 'sb_publishable_wt1aY_uj1ZR4z5RqIgDZQw_qYNoCl7D';
  const CACHE = 'dogo_landing_cms_v1';
  const ROOT_ID = 'authScreen';
  // Never editable here: login/signup forms, scripts, and the plan cards (edited under Plans & Pricing).
  const SKIP = '#authSection, script, style, noscript, svg, textarea, input, select, option, [data-plan-features], [data-plan-name], [id$="PriceAmount"], [id$="PricePeriod"], .su-plan-option, [data-cms-skip], [data-cms-ui]';
  const INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'SPAN', 'SMALL', 'MARK']);
  const SAFE_CSS = new Set(['color', 'background', 'background-color', 'font-weight', 'font-style', 'text-decoration']);

  let root = null, prepared = false, editing = false;
  const reg = new Map();      // key -> element (text / img / link / block)
  const orig = new Map();     // key -> original value (for reset and diffing)
  const byEl = { text: new Map(), img: new Map(), href: new Map(), hide: new Map() };  // element -> key
  function register(key, el) {
    reg.set(key, el);
    const kind = key.endsWith('@img') ? 'img' : key.endsWith('@href') ? 'href' : key.endsWith('@hide') ? 'hide' : 'text';
    byEl[kind].set(el, key);
  }
  let rows = {};              // key -> value currently saved in the database
  const changes = new Map();  // key -> new value, or null = remove override

  /* ---------- sanitising ---------- */
  function cleanStyle(s) {
    return String(s || '').split(';').map(d => d.trim()).filter(Boolean).filter(d => {
      const i = d.indexOf(':'); if (i < 0) return false;
      const p = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
      return SAFE_CSS.has(p) && /^[#\w\s%(),.\-]+$/.test(v) && !/url|expression|javascript/i.test(v);
    }).join('; ');
  }
  function safeHref(h) {
    h = String(h || '').trim();
    return /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|[\w\-./]+(\?.*)?(#.*)?$)/i.test(h) && !/^javascript:/i.test(h) ? h : '#';
  }
  function sanitize(html) {
    const t = document.createElement('template');
    t.innerHTML = String(html || '');
    (function walk(node) {
      Array.from(node.childNodes).forEach(ch => {
        if (ch.nodeType === 3) return;
        if (ch.nodeType !== 1) { ch.remove(); return; }
        const tag = ch.tagName;
        if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|FORM|INPUT|BUTTON|SVG|IMG)$/.test(tag)) { ch.remove(); return; }
        walk(ch);
        if (tag === 'DIV' || tag === 'P') {   // contenteditable line breaks
          ch.before(...Array.from(ch.childNodes), document.createElement('br')); ch.remove(); return;
        }
        if (!INLINE.has(tag) && tag !== 'A') { ch.replaceWith(...Array.from(ch.childNodes)); return; }
        const keepClass = (ch.getAttribute('class') || '').replace(/[^\w\- ]/g, '');
        const keepStyle = cleanStyle(ch.getAttribute('style'));
        const href = tag === 'A' ? safeHref(ch.getAttribute('href')) : null;
        Array.from(ch.attributes).forEach(a => ch.removeAttribute(a.name));
        if (keepClass) ch.setAttribute('class', keepClass);
        if (keepStyle) ch.setAttribute('style', keepStyle);
        if (href !== null) { ch.setAttribute('href', href); ch.setAttribute('rel', 'noopener'); }
      });
    })(t.content);
    return t.innerHTML;
  }

  /* ---------- finding editable things ---------- */
  const isIcon = el => el.tagName === 'SVG' || el.tagName === 'IMG' || (el.tagName === 'I' && /fa-|icon/.test(el.className || ''));
  function inlineOK(el) {
    if (!INLINE.has(el.tagName) || isIcon(el) || el.matches(SKIP)) return false;
    return Array.from(el.children).every(inlineOK);
  }
  function isTextUnit(el) {
    if (!(el.textContent || '').trim()) return false;
    return Array.from(el.children).every(inlineOK);
  }
  function wrapStrayText() {
    const todo = [];
    root.querySelectorAll('*').forEach(el => {
      if (el.closest(SKIP) || isTextUnit(el)) return;
      Array.from(el.childNodes).forEach(n => { if (n.nodeType === 3 && n.nodeValue.trim()) todo.push(n); });
    });
    todo.forEach(n => {
      const s = document.createElement('span'); s.setAttribute('data-cms-wrap', '');
      n.replaceWith(s); s.appendChild(n);
    });
  }
  function pathOf(el) {
    const parts = [];
    for (let e = el; e && e !== root; e = e.parentElement) {
      if (e.id && e !== el && e.id !== ROOT_ID) { parts.unshift('#' + e.id); break; }
      let i = 1; for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(e.tagName.toLowerCase() + i);
    }
    return parts.join('/');
  }
  function prepare() {
    if (prepared) return;
    root = document.getElementById(ROOT_ID);
    if (!root) return;
    prepared = true;
    wrapStrayText();
    (function walk(el) {
      Array.from(el.children).forEach(c => {
        if (c.matches(SKIP)) return;
        const p = pathOf(c);
        if (c.tagName === 'IMG') {
          register(p + '@img', c); orig.set(p + '@img', { src: c.getAttribute('src') || '', alt: c.getAttribute('alt') || '' });
        } else {
          if (c.tagName === 'A' && c.hasAttribute('href')) { register(p + '@href', c); orig.set(p + '@href', c.getAttribute('href')); }
          if (isTextUnit(c)) { register(p, c); orig.set(p, c.innerHTML); }
        }
        register(p + '@hide', c);
        if (!isTextUnit(c)) walk(c);
      });
    })(root);
    // Announcement banner lives outside the page tree so it never shifts any keys.
    const b = document.createElement('div');
    b.id = 'cmsBanner'; b.setAttribute('data-cms-ui', ''); b.hidden = true;
    b.style.cssText = 'background:#facc15;color:#0f172a;text-align:center;font:600 14px/1.4 system-ui,sans-serif;padding:10px 14px;position:relative;z-index:50';
    b.innerHTML = '<span data-cms-banner-text></span>';
    root.parentNode.insertBefore(b, root);
    register('banner', b.firstChild); orig.set('banner', '');
    register('banner@href', b); orig.set('banner@href', '');
  }

  /* ---------- applying saved values ---------- */
  function applyOne(key, v) {
    const el = reg.get(key); if (!el) return;
    if (key === 'banner') {
      el.innerHTML = sanitize(v && v.h);
      const bar = document.getElementById('cmsBanner'); if (bar) bar.hidden = !(el.textContent || '').trim() && !editing;
    } else if (key === 'banner@href') {
      /* handled via the banner link below */
    } else if (key.endsWith('@img')) {
      if (v && v.src) { el.removeAttribute('srcset'); el.setAttribute('src', v.src); } else el.setAttribute('src', orig.get(key).src);
      el.setAttribute('alt', v && v.alt != null ? v.alt : orig.get(key).alt);
    } else if (key.endsWith('@href')) {
      el.setAttribute('href', safeHref(v && v.u != null ? v.u : orig.get(key)));
    } else if (key.endsWith('@hide')) {
      if (v && v.hide) el.setAttribute('data-cms-hidden', ''); else el.removeAttribute('data-cms-hidden');
    } else {
      el.innerHTML = (v && v.h != null) ? sanitize(v.h) : orig.get(key);
    }
  }
  function applyAll(data) {
    // revert anything that is no longer overridden, then apply what is
    reg.forEach((_, k) => { if (!(k in data) && k in rows) applyOne(k, null); });
    Object.keys(data).forEach(k => applyOne(k, data[k]));
    const bu = data['banner@href'];
    const bar = document.getElementById('cmsBanner');
    if (bar) {
      const txt = bar.firstChild;
      let a = bar.querySelector('a');
      if (bu && bu.u && !a) { a = document.createElement('a'); a.style.cssText = 'color:inherit;text-decoration:underline'; txt.parentNode.insertBefore(a, txt); a.appendChild(txt); }
      if (a) a.setAttribute('href', safeHref(bu && bu.u));
      bar.hidden = !(txt.textContent || '').trim() && !editing;
    }
    rows = Object.assign({}, data);
  }
  function injectBaseCss() {
    if (document.getElementById('cmsBaseCss')) return;
    const s = document.createElement('style'); s.id = 'cmsBaseCss';
    s.textContent = 'body:not(.cms-editing) [data-cms-hidden]{display:none!important}';
    document.head.appendChild(s);
  }

  /* ---------- loading ---------- */
  async function fetchRows() {
    const r = await fetch(URL_ + '/rest/v1/landing_content?select=key,value', { headers: { apikey: KEY_, Authorization: 'Bearer ' + KEY_ } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json(); const o = {};
    list.forEach(x => { o[x.key] = x.value; });
    return o;
  }
  async function publicInit() {
    injectBaseCss();
    let cached = null; try { cached = JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (e) {}
    if (cached && Object.keys(cached).length) { prepare(); applyAll(cached); }
    try {
      const fresh = await fetchRows();
      try { localStorage.setItem(CACHE, JSON.stringify(fresh)); } catch (e) {}
      if (Object.keys(fresh).length || prepared) { prepare(); applyAll(fresh); }
    } catch (e) { /* keep built-in page */ }
  }

  /* ---------- editor ---------- */
  let sel = null, ui = null;
  const $ = (id) => document.getElementById(id);
  function toast(m) {
    let t = $('cmsToast'); if (!t) { t = document.createElement('div'); t.id = 'cmsToast'; t.setAttribute('data-cms-ui', ''); t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:120px;background:#0f172a;color:#fff;padding:10px 16px;border-radius:10px;font:600 13px system-ui;z-index:100001;max-width:90vw;text-align:center'; document.body.appendChild(t); }
    t.textContent = m; t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(() => t.style.display = 'none', 3500);
  }
  function keyOfEl(el, suffix) {
    const kind = suffix === '@img' ? 'img' : suffix === '@href' ? 'href' : suffix === '@hide' ? 'hide' : 'text';
    return byEl[kind].get(el) || null;
  }
  function currentValue(key, el) {
    if (key.endsWith('@img')) return { src: el.getAttribute('src') || '', alt: el.getAttribute('alt') || '' };
    if (key.endsWith('@href')) return { u: el.getAttribute('href') || '' };
    if (key.endsWith('@hide')) return { hide: el.hasAttribute('data-cms-hidden') };
    return { h: sanitize(el.innerHTML) };
  }
  function isDefault(key, v) {
    const o = orig.get(key);
    if (key.endsWith('@img')) return v.src === o.src && v.alt === o.alt;
    if (key.endsWith('@href')) return v.u === o;
    if (key.endsWith('@hide')) return !v.hide;
    return v.h === sanitize(o || '');
  }
  function track(key, el) {
    const v = currentValue(key, el);
    if (isDefault(key, v)) { if (key in rows) changes.set(key, null); else changes.delete(key); }
    else if (JSON.stringify(rows[key]) === JSON.stringify(v)) changes.delete(key);
    else changes.set(key, v);
    refreshBar();
  }
  function refreshBar() {
    const n = changes.size;
    $('cmsCount').textContent = n ? (n + ' unsaved change' + (n > 1 ? 's' : '')) : 'No unsaved changes';
    $('cmsSave').disabled = !n; $('cmsSave').style.opacity = n ? 1 : .5;
  }
  function setSel(el, kind) {
    if (sel && sel.el !== el) { sel.el.classList.remove('cms-sel'); if (sel.el.isContentEditable) sel.el.removeAttribute('contenteditable'); }
    sel = el ? { el, kind } : null;
    if (el) el.classList.add('cms-sel');
    ui.querySelectorAll('[data-need]').forEach(b => {
      const need = b.getAttribute('data-need').split(',');
      b.disabled = !el || !(need.includes('*') || need.includes(kind));
      b.style.opacity = b.disabled ? .35 : 1;
    });
    $('cmsHideBtn').textContent = el && el.hasAttribute('data-cms-hidden') ? 'Show' : 'Hide';
  }
  function targetFrom(node) {
    // innermost editable thing under the click: image, then text unit, else a block
    let el = node.nodeType === 1 ? node : node.parentElement;
    for (; el && el !== root && !el.hasAttribute('data-cms-ui'); el = el.parentElement) {
      if (el.id === 'cmsBanner' || el.closest('#cmsBanner')) return { el: reg.get('banner'), kind: 'text', key: 'banner' };
      if (el.tagName === 'IMG' && keyOfEl(el, '@img')) return { el, kind: 'img', key: keyOfEl(el, '@img') };
      const k = keyOfEl(el);
      if (k) return { el, kind: 'text', key: k };
    }
    return null;
  }
  async function pickImage() {
    if (!sel || sel.kind !== 'img') return;
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      if (f.size > 5 * 1024 * 1024) return toast('Image too large (max 5 MB).');
      toast('Uploading…');
      const ext = (f.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
      const { error } = await sb.storage.from('landing-assets').upload(path, f, { contentType: f.type, upsert: false });
      if (error) return toast('Upload failed: ' + error.message);
      const { data } = sb.storage.from('landing-assets').getPublicUrl(path);
      sel.el.removeAttribute('srcset'); sel.el.setAttribute('src', data.publicUrl);
      track(keyOfEl(sel.el, '@img'), sel.el); toast('Image replaced. Remember to Save.');
    };
    inp.click();
  }
  function editImageUrl() {
    if (!sel || sel.kind !== 'img') return;
    const u = prompt('Image address (https://…)', sel.el.getAttribute('src') || ''); if (u === null) return;
    const alt = prompt('Short description of the image (for accessibility)', sel.el.getAttribute('alt') || '');
    sel.el.removeAttribute('srcset'); sel.el.setAttribute('src', safeHref(u)); if (alt !== null) sel.el.setAttribute('alt', alt);
    track(keyOfEl(sel.el, '@img'), sel.el);
  }
  function editLink() {
    if (!sel) return;
    const a = sel.el.closest('a[href]') || (sel.el.id === 'cmsBanner' ? sel.el : null);
    if (sel.key === 'banner' || (sel.el.closest && sel.el.closest('#cmsBanner'))) {
      const bar = $('cmsBanner'); const cur = (bar.querySelector('a') || {}).href || '';
      const u = prompt('Where should the banner link to? (leave empty for no link)', cur); if (u === null) return;
      let an = bar.querySelector('a'); const txt = bar.querySelector('[data-cms-banner-text]');
      if (u && !an) { an = document.createElement('a'); an.style.cssText = 'color:inherit;text-decoration:underline'; txt.parentNode.insertBefore(an, txt); an.appendChild(txt); }
      if (an) an.setAttribute('href', u ? safeHref(u) : '#');
      const nv = u ? { u: safeHref(u) } : null;
      if (nv) changes.set('banner@href', nv); else if ('banner@href' in rows) changes.set('banner@href', null); else changes.delete('banner@href');
      refreshBar(); return;
    }
    if (a) {
      const u = prompt('Link address', a.getAttribute('href') || ''); if (u === null) return;
      a.setAttribute('href', safeHref(u)); const k = keyOfEl(a, '@href'); if (k) track(k, a);
    } else if (sel.kind === 'text') {
      const u = prompt('Make the selected text a link to:', 'https://'); if (!u) return;
      sel.el.focus(); document.execCommand('createLink', false, safeHref(u)); track(sel.key, sel.el);
    }
  }
  function toggleHide() {
    if (!sel) return;
    const hkey = keyOfEl(sel.el, '@hide');
    if (!hkey) return toast('This item can’t be hidden.');
    if (sel.el.hasAttribute('data-cms-hidden')) sel.el.removeAttribute('data-cms-hidden'); else sel.el.setAttribute('data-cms-hidden', '');
    track(hkey, sel.el); setSel(sel.el, sel.kind);
  }
  function resetSel() {
    if (!sel) return;
    ['text', 'img', 'href', 'hide'].forEach(kind => {
      const k = byEl[kind].get(sel.el); if (!k || k === 'banner@href') return;
      applyOne(k, null); if (k in rows) changes.set(k, null); else changes.delete(k);
    });
    if (sel.key === 'banner') { reg.get('banner').innerHTML = ''; }
    refreshBar(); toast('Reset to the original.');
  }
  function selectParent() {
    if (!sel) return;
    let p = sel.el.parentElement;
    while (p && p !== root && !keyOfEl(p, '@hide')) p = p.parentElement;
    if (!p || p === root) return toast('Already at the top of the page.');
    const t = isTextUnit(p) ? 'text' : 'block';
    setSel(p, t); sel.key = t === 'text' ? keyOfEl(p) : null; p.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  async function save() {
    const up = [], del = [];
    changes.forEach((v, k) => { if (v === null) del.push(k); else up.push({ key: k, value: v }); });
    $('cmsSave').disabled = true; toast('Saving…');
    if (up.length) { const { error } = await sb.from('landing_content').upsert(up, { onConflict: 'key' }); if (error) { refreshBar(); return toast('Could not save: ' + error.message); } }
    if (del.length) { const { error } = await sb.from('landing_content').delete().in('key', del); if (error) { refreshBar(); return toast('Could not save: ' + error.message); } }
    up.forEach(r => { rows[r.key] = r.value; }); del.forEach(k => { delete rows[k]; });
    changes.clear(); try { localStorage.removeItem(CACHE); } catch (e) {}
    refreshBar(); toast('Saved. The live landing page is updated.');
  }
  function buildUi() {
    const css = document.createElement('style');
    css.textContent = [
      'body.cms-editing{padding-bottom:130px}',
      '.cms-editing #cmsBanner{display:block!important}',
      '.cms-editing #cmsBanner [data-cms-banner-text]:empty:before{content:"Tap to add an announcement banner";opacity:.6}',
      '.cms-editing #authScreen *{cursor:text}',
      '.cms-editing #authScreen img{cursor:pointer}',
      '.cms-editing #authScreen .cms-hover{outline:2px dashed rgba(37,99,235,.55);outline-offset:2px}',
      '.cms-editing .cms-sel{outline:3px solid #2563eb!important;outline-offset:2px;position:relative}',
      '.cms-editing [data-cms-hidden]{opacity:.35;outline:2px dashed #ef4444;outline-offset:2px}',
      '#cmsTools button{font:700 13px system-ui;border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:10px;padding:10px 12px;min-width:44px}',
      '#cmsTools button:disabled{cursor:not-allowed}',
      '#cmsTools button.pri{background:#2563eb;color:#fff;border-color:#2563eb}',
      '#cmsTools button.dng{color:#b91c1c}'
    ].join('\n');
    document.head.appendChild(css);
    ui = document.createElement('div'); ui.id = 'cmsTools'; ui.setAttribute('data-cms-ui', '');
    ui.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:100000;background:#f8fafc;border-top:1px solid #cbd5e1;padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px));box-shadow:0 -6px 24px rgba(0,0,0,.15);font-family:system-ui,sans-serif';
    ui.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">' +
        '<strong style="font-size:13px;flex:1;min-width:140px">Editing landing page<br><span id="cmsCount" style="font-weight:500;color:#475569">No unsaved changes</span></strong>' +
        '<button id="cmsDiscard">Discard</button><button id="cmsExit" class="dng">Exit</button><button id="cmsSave" class="pri" disabled>Save</button></div>' +
      '<div style="display:flex;gap:6px;overflow-x:auto;white-space:nowrap">' +
        '<button data-need="*" id="cmsUp" title="Select the block around this">↑ Parent</button>' +
        '<button data-need="text" id="cmsB"><b>B</b></button><button data-need="text" id="cmsI"><i>I</i></button>' +
        '<button data-need="text,block" id="cmsLink">Link</button>' +
        '<button data-need="img" id="cmsPhoto">Photo</button><button data-need="img" id="cmsUrl">Image URL</button>' +
        '<button data-need="*" id="cmsHideBtn">Hide</button><button data-need="*" id="cmsReset">Reset</button></div>' +
      '<div style="font-size:11px;color:#64748b;margin-top:6px">Tap any text or image to edit it. Prices &amp; plan details are edited in Admin → Settings → Plans.</div>';
    document.body.appendChild(ui);
    $('cmsSave').onclick = save;
    $('cmsDiscard').onclick = () => { if (!changes.size || confirm('Discard all unsaved changes?')) location.reload(); };
    $('cmsExit').onclick = () => { if (!changes.size || confirm('You have unsaved changes. Leave without saving?')) location.href = 'admin/index.html'; };
    $('cmsUp').onclick = selectParent; $('cmsHideBtn').onclick = toggleHide; $('cmsReset').onclick = resetSel;
    $('cmsLink').onclick = editLink; $('cmsPhoto').onclick = pickImage; $('cmsUrl').onclick = editImageUrl;
    $('cmsB').onclick = () => { if (sel) { sel.el.focus(); document.execCommand('bold'); track(sel.key, sel.el); } };
    $('cmsI').onclick = () => { if (sel) { sel.el.focus(); document.execCommand('italic'); track(sel.key, sel.el); } };
    ui.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
    setSel(null);
    const bar = $('cmsBanner');
    // Capture phase so links/buttons on the page don't navigate while editing.
    document.addEventListener('click', e => {
      if (e.target.closest('[data-cms-ui]') && !e.target.closest('#cmsBanner')) return;
      if (!e.target.closest('#' + ROOT_ID) && !e.target.closest('#cmsBanner')) return;
      e.preventDefault(); e.stopPropagation();
      const t = targetFrom(e.target);
      if (!t) { const blk = e.target.closest('#' + ROOT_ID + ' *'); if (blk && keyOfEl(blk, '@hide')) { setSel(blk, 'block'); sel.key = null; } return; }
      setSel(t.el, t.kind); sel.key = t.key;
      if (t.kind === 'text') {
        t.el.setAttribute('contenteditable', 'true'); t.el.focus();
        if (t.el.id === 'cmsBanner') return;
      }
    }, true);
    document.addEventListener('input', e => { if (sel && sel.kind === 'text' && sel.el.contains(e.target)) track(sel.key, sel.el); }, true);
    document.addEventListener('paste', e => {
      if (!sel || !sel.el.isContentEditable) return;
      e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && sel && sel.el.isContentEditable) { e.preventDefault(); document.execCommand('insertLineBreak'); }
    }, true);
    document.addEventListener('mouseover', e => {
      document.querySelectorAll('.cms-hover').forEach(n => n.classList.remove('cms-hover'));
      const t = targetFrom(e.target); if (t && t.el !== (sel && sel.el)) t.el.classList.add('cms-hover');
    });
    window.addEventListener('beforeunload', e => { if (changes.size) { e.preventDefault(); e.returnValue = ''; } });
  }
  async function bootEdit() {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error('Sign in as a platform admin first.');
      const { data: ok, error } = await sb.rpc('is_platform_admin');
      if (error || !ok) throw new Error('Only platform admins can edit the landing page.');
    } catch (e) {
      alert(e.message || 'Not allowed.'); location.replace(location.pathname); return false;
    }
    if (typeof setAppLoggedIn === 'function') setAppLoggedIn(false);
    document.querySelectorAll('#installBanner').forEach(n => n.remove());
    editing = true; document.body.classList.add('cms-editing');
    prepare(); injectBaseCss();
    try { applyAll(await fetchRows()); } catch (e) { toast('Could not load saved edits yet (run the landing_content migration).'); }
    buildUi();
    return true;
  }

  window.DogoCMS = { bootEdit, sanitize, _debug: { prepare, reg, orig, applyAll, pathOf } };
  const isEdit = new URLSearchParams(location.search).get('cms') === 'edit';
  if (!isEdit) {
    const go = () => publicInit();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }
})();
