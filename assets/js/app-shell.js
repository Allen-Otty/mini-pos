/* ==========================================================================
   Dogo POS — shared app shell (header + nav grid)
   Every page calls DogoShell.render({ active: 'dashboard', businessName })
   once its #dogoHeaderRoot / #dogoNavRoot elements exist. Keeping this in
   one file means the nav only has to be edited in one place when a page
   is added, renamed, or reordered.
   ========================================================================== */

(function () {
  const ICONS = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>',
    contacts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c0-1.7 1.6-3 3-3s3 1.3 3 3"/><line x1="14" y1="9" x2="18" y2="9"/><line x1="14" y1="13" x2="18" y2="13"/></svg>',
    products: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/></svg>',
    purchases: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 3h2l2.4 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 7H6"/></svg>',
    sales: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M6 3h8l5 5v13H6z"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="15" y2="16"/></svg>',
    inventory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>',
    expenses: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 3h2l2.4 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 7H6"/></svg>',
    reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>',
    fixedassets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><path d="M3 9l9-5 9 5"/></svg>',
    loans: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="14" x2="10" y2="14"/></svg>',
    equity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 6"/><polyline points="14 6 21 6 21 13"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.2.6.7 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
  };

  // Single source of truth for every page in the app. Add a page here and it
  // shows up in the nav grid on every other page automatically.
  const BUILT = {
    dashboard: true,
    customers: true,
    catalog: true,
    purchases: true,
    sell: true,
    inventory: true,
    expenses: true,
    reports: true,
    fixedassets: true,
    loans: true,
    equity: true,
    restaurant: true,
    settings: true
  };
  // NOTE: 'Legacy Modules' link is added to the nav panel below
  const LEGACY = 'index.html?legacy=1';
  const NAV_ITEMS_RAW = [
    { id: 'dashboard', label: 'Overview', href: 'dashboard.html', icon: 'overview' },
    { id: 'customers', label: 'Contacts', href: 'customers.html', icon: 'contacts' },
    { id: 'catalog', label: 'Products', href: 'catalog.html', icon: 'products' },
    { id: 'purchases', label: 'Purchases', href: 'purchases.html', icon: 'purchases' },
    { id: 'sell', label: 'Sales', href: 'sell.html', icon: 'sales' },
    { id: 'restaurant', label: 'Restaurant', href: 'restaurant.html', icon: 'products' },
    { id: 'inventory', label: 'Inventory', href: 'inventory.html', icon: 'inventory' },
    { id: 'expenses', label: 'Expenses', href: 'expenses.html', icon: 'expenses' },
    { id: 'reports', label: 'Reports', href: 'reports.html', icon: 'reports' },
    { id: 'fixedassets', label: 'Fixed Assets', href: 'fixedassets.html', icon: 'fixedassets' },
    { id: 'loans', label: 'Loans', href: 'loans.html', icon: 'loans' },
    { id: 'equity', label: 'Equity', href: 'equity.html', icon: 'equity' },
    { id: 'settings', label: 'Settings', href: 'settings.html', icon: 'settings' }
  ];
  // Pages not yet migrated open the existing app so no nav link is ever a dead end.
  const NAV_ITEMS = NAV_ITEMS_RAW.map(i => BUILT[i.id] ? i : Object.assign({}, i, { href: LEGACY }));

  function renderHeader(root, opts) {
    const apkHref = (typeof window !== 'undefined' && window.location.hostname.includes('netlify.app'))
      ? 'https://allen-otty.github.io/mini-pos/dogo-pos.apk'
      : '/dogo-pos.apk';

    const exeHref = (typeof window !== 'undefined' && window.location.hostname.includes('netlify.app'))
      ? 'https://raw.githubusercontent.com/Allen-Otty/mini-pos/main/dogo-pos.exe'
      : '/dogo-pos.exe';

    root.innerHTML = `
      <header class="dogo-header">
        <button class="dogo-header__icon-btn dogo-hide-desktop" id="dogoNavToggle" aria-label="Menu">${ICONS.menu}</button>
        <a href="dashboard.html" class="dogo-header__brand">
          <span class="dogo-header__logo">D</span>
          <span>${opts.businessName || 'Dogo POS'}</span>
        </a>
        <div class="dogo-header__actions" style="display:flex;align-items:center;gap:8px;">
          <button id="dogoSyncPill" class="dogo-btn" onclick="window.DogoData && window.DogoData.syncOfflineSales && window.DogoData.syncOfflineSales()" style="display:inline-flex;align-items:center;padding:5px 10px;font-size:12px;border-radius:999px;font-weight:700;border:1px solid #00d26a;background:rgba(0,210,106,0.12);color:var(--dogo-neon-dark);cursor:pointer;" title="Sync status">
            <span style="width:7px;height:7px;border-radius:50%;background:#00d26a;display:inline-block;margin-right:4px;"></span>Online
          </button>
          <a href="${exeHref}" download="dogo-pos.exe" class="dogo-btn" title="Download Windows Desktop App (v1.0.0)" style="padding:6px 12px;font-size:12px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;background:#00a4ef;color:#ffffff;border:1px solid #00a4ef;border-radius:999px;font-weight:700;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.801"/></svg>
            <span>Windows .EXE</span>
          </a>
          <a href="${apkHref}" download="dogo-pos.apk" class="dogo-btn dogo-btn--primary" title="Download Android APK Release (v1.0.0)" style="padding:6px 12px;font-size:12px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;box-shadow:0 0 12px var(--dogo-neon-glow);border-radius:999px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-1.0002s.4482-1.0001.9993-1.0001c.5516 0 .9997.4485.9997 1.0001 0 .5516-.4481 1.0002-.9997 1.0002m-11.046 0c-.5511 0-.9993-.4486-.9993-1.0002s.4482-1.0001.9993-1.0001c.5516 0 .9997.4485.9997 1.0001 0 .5516-.4481 1.0002-.9997 1.0002m11.4045-6.02l1.996-3.456a.4158.4158 0 00-.1523-.5676.416.416 0 00-.5681.1523l-2.0223 3.5028c-1.5791-.7224-3.3496-1.1274-5.2348-1.1274s-3.6557.405-5.2348 1.1274L4.6398 5.4501a.4162.4162 0 00-.5681-.1523.4157.4157 0 00-.1523.5676l1.996 3.456C2.6884 11.0962.5 14.5934.5 18.665h23c0-4.0716-2.1884-7.5688-5.6185-9.3436"/></svg>
            <span>Android APK</span>
          </a>
          <button class="dogo-header__icon-btn" id="dogoLogoutBtn" aria-label="Log out">${ICONS.logout}</button>
        </div>
      </header>
    `;
    const toggle = root.querySelector('#dogoNavToggle');
    const logout = root.querySelector('#dogoLogoutBtn');
    if (toggle) toggle.addEventListener('click', () => document.body.classList.toggle('dogo-nav-open'));
    if (logout && typeof opts.onLogout === 'function') logout.addEventListener('click', opts.onLogout);
  }

  function renderNav(root, opts) {
    const items = opts.items || NAV_ITEMS;
    const apkHref = (typeof window !== 'undefined' && window.location.hostname.includes('netlify.app'))
      ? 'https://allen-otty.github.io/mini-pos/dogo-pos.apk'
      : '/dogo-pos.apk';

    const exeHref = (typeof window !== 'undefined' && window.location.hostname.includes('netlify.app'))
      ? 'https://raw.githubusercontent.com/Allen-Otty/mini-pos/main/dogo-pos.exe'
      : '/dogo-pos.exe';

    root.innerHTML = `
      <nav class="dogo-nav-panel" id="dogoNavPanel">
        <div class="dogo-nav-grid">
          ${items.map(item => `
            <a class="dogo-nav-item ${item.id === opts.active ? 'is-active' : ''}" href="${item.href}">
              ${ICONS[item.icon] || ''}<span>${item.label}</span>
            </a>
          `).join('')}
          <a class="dogo-nav-item" href="${exeHref}" download="dogo-pos.exe" style="color:#00a4ef;font-weight:700;" title="Download Windows Desktop App (.exe)">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width:17px;height:17px;"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.801"/></svg>
            <span>Windows .EXE</span>
          </a>
          <a class="dogo-nav-item" href="${apkHref}" download="dogo-pos.apk" style="color:var(--dogo-neon-dark);font-weight:700;" title="Download Android Release APK">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:17px;height:17px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Android APK</span>
          </a>
          <a class="dogo-nav-item" href="index.html?legacy=1" style="margin-left:auto;color:var(--dogo-gold-dark);font-weight:700;"><span>Legacy Modules &rarr;</span></a>
        </div>
      </nav>
    `;
  }

  window.DogoShell = {
    NAV_ITEMS,
    ICONS,
    render(opts) {
      opts = opts || {};
      const headerRoot = document.getElementById('dogoHeaderRoot');
      const navRoot = document.getElementById('dogoNavRoot');
      if (headerRoot) renderHeader(headerRoot, opts);
      if (navRoot) renderNav(navRoot, opts);
    }
  };
})();
