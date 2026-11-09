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
    pill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 20.5l10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    invoice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16l3-2 3 2 3-2 3 2 3-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
    kitchen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 9.18 0A4 4 0 0 1 18 13.87V21H6z"/><line x1="6" y1="17" x2="18" y2="17"/></svg>',
    tables: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9.5a3 3 0 0 0-3-1.5c-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.6 0 1.3-1.3 2.2-3 2.2a3.3 3.3 0 0 1-3-1.5"/><line x1="12" y1="6" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="18"/></svg>',
    staff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2"/><circle cx="18" cy="17" r="3"/><path d="M18 12v2M18 20v2M13.8 14.5l1.7 1M20.5 18.5l1.7 1M13.8 19.5l1.7-1M20.5 15.5l1.7-1"/></svg>',
    dot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/></svg>',
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
    invoices: true,
    tables: true,
    orders: true,
    kitchen: true,
    bills: true,
    inventory: true,
    expenses: true,
    reports: true,
    fixedassets: true,
    loans: true,
    equity: true,
    settings: true,
    team: true
  };
  // NOTE: 'Legacy Modules' link is added to the nav panel below
  const LEGACY = 'index.html?legacy=1';

  // ------------------------------------------------------------------------
  // Menu definition. One list, filtered and re-labelled per business type, so
  // a pharmacy sees Medicines / Patients / Stock & Expiry while a restaurant
  // sees Take Orders / Kitchen Board / Settle Bills, and so on.
  //   only: [types]  -> shown only for those business types
  //   not:  [types]  -> hidden for those business types
  //   labels: {type: 'Label'} -> per-type wording (falls back to `label`)
  // ------------------------------------------------------------------------
  const MENU = [
    { id: 'dashboard', label: 'Dashboard', href: 'dashboard.html', icon: 'overview' },
    { label: 'Inventory', icon: 'inventory', labels: { restaurant: 'Menu & Stock', sme: 'Catalogue' }, children: [
      { id: 'catalog', label: 'Products', href: 'catalog.html', icon: 'products',
        labels: { pharmacy: 'Medicines', restaurant: 'Menu Items', sme: 'Services & Products', agrovet: 'Agrovet Stock', hardware: 'Stock Items', wines: 'Wines & Spirits', kiosk: 'Kiosk Items', wholesale: 'Wholesale Stock' },
        icons: { pharmacy: 'pill' } },
      { id: 'inventory', label: 'Stock Levels', href: 'inventory.html', icon: 'inventory',
        labels: { pharmacy: 'Stock & Expiry', agrovet: 'Stock & Expiry', restaurant: 'Ingredients & Stock', wines: 'Stock & Counts' },
        icons: { pharmacy: 'clock', agrovet: 'clock' } }
    ]},
    { label: 'Sales', icon: 'sales', labels: { pharmacy: 'Dispensing', restaurant: 'Restaurant', wholesale: 'Sales & Orders' }, children: [
      { id: 'sell', label: 'New Sale', href: 'sell.html', icon: 'sales', not: ['restaurant'],
        labels: { pharmacy: 'Point of Sale', kiosk: 'Quick Sale', boutique: 'Checkout', wines: 'Till', agrovet: 'Counter', wholesale: 'Wholesale Sale' } },
      { id: 'orders', label: 'Take Orders', href: 'orders.html', icon: 'sales', only: ['restaurant'] },
      { id: 'kitchen', label: 'Kitchen Board', href: 'kitchen.html', icon: 'kitchen', only: ['restaurant'] },
      { id: 'tables', label: 'Menu & Tables', href: 'tables.html', icon: 'tables', only: ['restaurant'] },
      { id: 'bills', label: 'Settle Bills', href: 'bills.html', icon: 'invoice', only: ['restaurant'] },
      { id: 'invoices', label: 'Invoices', href: 'invoices.html#invoice', icon: 'invoice', not: ['kiosk', 'restaurant'] },
      { id: 'quotes', label: 'Quotations', href: 'invoices.html#quote', icon: 'invoice', not: ['kiosk', 'restaurant'] },
      { id: 'creditnotes', label: 'Credit Notes', href: 'invoices.html#credit_note', icon: 'loans', not: ['kiosk', 'restaurant'] }
    ]},
    { label: 'Purchases', icon: 'truck', labels: { pharmacy: 'Purchases' }, children: [
      { id: 'po', label: 'Purchase Orders', href: 'purchases.html#orders', icon: 'invoice' },
      { id: 'grn', label: 'Goods Received', href: 'purchases.html#receipts', icon: 'truck' },
      { id: 'suppay', label: 'Supplier Payments', href: 'purchases.html#payments', icon: 'wallet' },
      { id: 'suppliers', label: 'Suppliers', href: 'purchases.html#suppliers', icon: 'users' }
    ]},
    { id: 'customers', label: 'Customers', href: 'customers.html', icon: 'users',
      labels: { pharmacy: 'Patients & Contacts', agrovet: 'Farmers', boutique: 'Shoppers', sme: 'Clients', restaurant: 'Guests', wholesale: 'Customers & Credit' } },
    { label: 'Finance', icon: 'wallet', children: [
      { id: 'expenses', label: 'Expenses', href: 'expenses.html', icon: 'expenses' },
      { id: 'fixedassets', label: 'Fixed Assets', href: 'fixedassets.html', icon: 'fixedassets', not: ['kiosk'] },
      { id: 'loans', label: 'Loans', href: 'loans.html', icon: 'loans', not: ['kiosk'] },
      { id: 'equity', label: 'Equity', href: 'equity.html', icon: 'equity', not: ['kiosk'] }
    ]},
    { id: 'reports', label: 'Reports', href: 'reports.html', icon: 'reports' },
    { label: 'Staff & Access', icon: 'staff', admin: true, children: [
      { id: 'team', label: 'Staff Members', href: 'team.html', icon: 'users' },
      { id: 'branches', label: 'Branches', href: 'settings.html#tab-team', icon: 'tables' }
    ]},
    { label: 'Settings', icon: 'settings', admin: true, children: [
      { id: 'set_general', label: 'General', href: 'settings.html#tab-business', icon: 'settings' },
      { id: 'set_receipt', label: 'Receipt & Invoice', href: 'settings.html#tab-receipt', icon: 'invoice' },
      { id: 'set_pay', label: 'Payment', href: 'settings.html#tab-mpesa', icon: 'wallet' },
      { id: 'set_tax', label: 'Tax (eTIMS)', href: 'settings.html#tab-etims', icon: 'reports' },
      { id: 'set_hw', label: 'Hardware', href: 'settings.html#tab-hardware', icon: 'tables' },
      { id: 'set_look', label: 'Appearance', href: 'settings.html#tab-appearance', icon: 'settings' },
      { id: 'set_acct', label: 'Account & Security', href: 'settings.html#tab-account', icon: 'staff' }
    ]},
    { id: 'console', label: 'Admin Console', href: 'admin/index.html', icon: 'staff', platform: true }
  ];

  // Pages not yet migrated open the existing app so no nav link is ever a dead end.
  const hrefFor = item => item.href;

  // Accepts the short signup value ("Hotel", "SME") or the long label ("Hotel / Restaurant").
  function typeKey(raw) {
    const t = String(raw || '').toLowerCase();
    if (t.includes('pharm') || t.includes('chemist')) return 'pharmacy';
    if (t.includes('agro')) return 'agrovet';
    if (t.includes('boutique') || t.includes('fashion')) return 'boutique';
    if (t.includes('wine') || t.includes('spirit') || t.includes('liquor')) return 'wines';
    if (t.includes('hotel') || t.includes('restaurant')) return 'restaurant';
    if (t.includes('hardware')) return 'hardware';
    if (t.includes('supermarket')) return 'supermarket';
    if (t.includes('wholesale')) return 'wholesale';
    if (t.includes('kiosk') || t.includes('kibanda')) return 'kiosk';
    if (t.includes('sme') || t.includes('general') || t.includes('service')) return 'sme';
    return 'retail';
  }
  const TYPE_LABEL = { pharmacy: 'Pharmacy', agrovet: 'Agrovet', boutique: 'Boutique', wines: 'Wines & Spirits', restaurant: 'Hotel / Restaurant',
    hardware: 'Hardware', supermarket: 'Supermarket', wholesale: 'Wholesale', kiosk: 'Kiosk', sme: 'SME / Services', retail: 'Retail Shop' };

  const STORE_KEY = 'dogo_biz_type';
  function rememberedType() { try { return localStorage.getItem(STORE_KEY) || ''; } catch (e) { return ''; } }
  function remember(raw) { try { if (raw) localStorage.setItem(STORE_KEY, raw); } catch (e) {} }

  // The menu for one business type: a tree of links and expandable groups.
  function menuFor(raw, showTables, flags) {
    flags = flags || {};
    let key = typeKey(raw);
    if (!raw && showTables) key = 'restaurant';
    const ok = i => (!i.only || i.only.includes(key)) && (!i.not || !i.not.includes(key)) && (!i.platform || flags.platform) && (!i.admin || flags.admin !== false);
    const make = i => ({
      id: i.id, label: (i.labels && i.labels[key]) || i.label,
      href: i.href ? hrefFor(i) : '', icon: (i.icons && i.icons[key]) || i.icon
    });
    const out = [];
    MENU.filter(ok).forEach(i => {
      if (!i.children) { out.push(make(i)); return; }
      const kids = i.children.filter(ok).map(make);
      if (!kids.length) return;
      if (kids.length === 1) { out.push(Object.assign({}, kids[0], { icon: kids[0].icon })); return; }
      out.push({ label: (i.labels && i.labels[key]) || i.label, icon: i.icon, children: kids });
    });
    return out;
  }
  const flat = tree => tree.reduce((a, n) => a.concat(n.children ? n.children : [n]), []);
  const NAV_ITEMS = flat(menuFor('', false));

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLLAPSE_KEY = 'dogo_sidebar_collapsed';
  const isCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; } };
  function applyCollapsed(on) {
    document.body.classList.toggle('dogo-sidebar-collapsed', !!on);
    try { localStorage.setItem(COLLAPSE_KEY, on ? '1' : '0'); } catch (e) {}
  }

  function initials(n) { return (String(n || 'D').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || 'D').toUpperCase(); }

  function renderHeader(root, opts, tree) {
    const all = flat(tree);
    let crumb = '<a href="dashboard.html">Home</a>';
    tree.forEach(n => {
      if (n.href && isCur(n.href) && n.id !== 'dashboard') crumb += `<span class="dogo-topbar__crumb-sep">›</span><b>${esc(n.label)}</b>`;
      if (n.children) n.children.forEach(c => { if (isCur(c.href)) crumb += `<span class="dogo-topbar__crumb-sep">›</span><span>${esc(n.label)}</span><span class="dogo-topbar__crumb-sep">›</span><b>${esc(c.label)}</b>`; });
    });
    if (curFile() === 'dashboard.html') crumb += `<span class="dogo-topbar__crumb-sep">›</span><b>Dashboard</b>`;
    const who = opts.userName || opts.businessName || 'Dogo POS';
    root.innerHTML = `
      <header class="dogo-header dogo-topbar">
        <button class="dogo-header__icon-btn dogo-topbar__menu" id="dogoNavToggle" aria-label="Menu">${ICONS.menu}</button>
        ${curFile() === 'dashboard.html' ? '' : '<button class="dogo-header__icon-btn dogo-topbar__back" id="dogoBackBtn" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>'}
        <a href="dashboard.html" class="dogo-header__brand dogo-topbar__brand">
          <span class="dogo-header__logo"><img src="icons/icon-192.png" alt="Dogo POS"></span>
          <span>${esc(opts.businessName || 'Dogo POS')}</span>
        </a>
        <div class="dogo-topbar__crumb">${crumb}</div>
        <label class="dogo-topbar__search">
          ${ICONS.search}
          <input type="search" id="dogoJump" list="dogoJumpList" placeholder="Search pages..." autocomplete="off" aria-label="Search pages">
          <datalist id="dogoJumpList">${all.map(i => `<option value="${esc(i.label)}"></option>`).join('')}</datalist>
        </label>
        <div class="dogo-header__actions">
          <button type="button" class="dogo-header__icon-btn dogo-topbar__searchbtn" id="dogoSearchBtn" aria-label="Search pages">${ICONS.search}</button>
          <a class="dogo-topbar__bell" href="dashboard.html" aria-label="Alerts">${ICONS.bell}<i></i></a>
          <div class="dogo-topbar__user">
            <span class="dogo-avatar">${opts.avatarUrl ? `<img src="${esc(opts.avatarUrl)}" alt="" onerror="this.remove()">` : ""}<span>${esc(initials(who))}</span></span>
            <span class="dogo-topbar__who"><b>${esc(who)}</b><small>${esc(opts.roleLabel || opts.typeLabel || '')}</small></span>
          </div>
          <button class="dogo-header__icon-btn dogo-topbar__logout" id="dogoLogoutBtn" aria-label="Log out">${ICONS.logout}</button>
        </div>
      </header>
    `;
    const toggle = root.querySelector('#dogoNavToggle');
    const logout = root.querySelector('#dogoLogoutBtn');
    const backB = root.querySelector('#dogoBackBtn'); if (backB) backB.addEventListener('click', () => { if (history.length > 1) history.back(); else location.href = 'dashboard.html'; });
    const jump = root.querySelector('#dogoJump');
    const sbtn = root.querySelector('#dogoSearchBtn');
    if (sbtn) sbtn.addEventListener('click', () => { document.body.classList.toggle('dogo-search-open'); if (jump) jump.focus(); });
    if (toggle) toggle.addEventListener('click', () => document.body.classList.toggle('dogo-nav-open'));
    if (logout && typeof opts.onLogout === 'function') logout.addEventListener('click', opts.onLogout);
    if (jump) {
      const go = () => {
        const q = jump.value.trim().toLowerCase();
        if (!q) return;
        const hit = all.find(i => i.label.toLowerCase() === q) || all.find(i => i.label.toLowerCase().includes(q));
        if (hit) window.location.href = hit.href;
      };
      jump.addEventListener('change', go);
      jump.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    }
  }

  const curFile = () => (location.pathname.split('/').pop() || 'index.html');
  function isCur(href) {
    if (!href) return false;
    const [f, h] = href.split('#');
    const last = f.split('/').pop();
    if (last !== curFile()) return false;
    const hash = location.hash.replace('#', '');
    return h ? h === hash || (!hash && h === DEFAULT_HASH[last]) : true;
  }
  const DEFAULT_HASH = { 'invoices.html': 'invoice', 'purchases.html': 'orders', 'settings.html': 'tab-business' };

  // Colour themes (same five as the reference). Saved per business as the primary hex in businesses.theme_color.
  const THEMES = {
    '#003032': { name: 'Teal', accent: '#c9f15a' },
    '#1e2a78': { name: 'Blue', accent: '#7c8cf8' },
    '#5b0fa8': { name: 'Purple', accent: '#d36bf5' },
    '#0b5d3b': { name: 'Green', accent: '#22e08d' },
    '#7a0c0c': { name: 'Red', accent: '#f87171' }
  };
  const mix = (hex, to, t) => { const n = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); const a = n(hex), b = n(to); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
  function applyTheme(color) {
    const key = String(color || '').toLowerCase();
    const prim = THEMES[key] ? key : '#003032', acc = THEMES[prim].accent;
    const st = document.body.style;
    st.setProperty('--dogo-side-bg', prim);
    st.setProperty('--dogo-side-bg-2', mix(prim, '#000000', .18));
    st.setProperty('--dogo-side-active-bg', mix(prim, '#ffffff', .14));
    st.setProperty('--dogo-lime', acc);
    st.setProperty('--dogo-lime-2', mix(acc, '#000000', .1));
    st.setProperty('--dogo-lime-hi', mix(acc, '#ffffff', .4));
    st.setProperty('--dogo-side-ink', mix(prim, '#ffffff', .8));
  }


  // Back button / swipe-back (Android app calls this): close what is open first, then go back a page.
  // Returns 'handled', or 'exit' when already at the home screen (the app then asks for a second press).
  window.DogoBack = function () {
    try {
      const chat = document.getElementById('dgh');
      if (chat && getComputedStyle(chat).display !== 'none') { const x = chat.querySelector('header button'); if (x) x.click(); return 'handled'; }
      const m = document.querySelector('.dogo-modal.open, .modal-overlay.open, .modal-overlay.active');
      if (m) { const c = m.querySelector('[data-close], .dogo-modal__close, .modal-close, .btn-cancel, #closeBtn'); if (c) c.click(); else m.classList.remove('open', 'active'); return 'handled'; }
      if (document.body.classList.contains('dogo-nav-open')) { document.body.classList.remove('dogo-nav-open'); return 'handled'; }
      if (document.body.classList.contains('dogo-search-open')) { document.body.classList.remove('dogo-search-open'); return 'handled'; }
      const f = curFile();
      if (f === 'dashboard.html' || f === '' || f === 'index.html') return 'exit';
      if (history.length > 1) { history.back(); return 'handled'; }
      location.href = 'dashboard.html'; return 'handled';
    } catch (e) { return 'exit'; }
  };

  const OPEN_KEY = 'dogo_nav_open';
  function openSet() { try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'); } catch (e) { return []; } }
  function saveOpen(a) { try { localStorage.setItem(OPEN_KEY, JSON.stringify(a)); } catch (e) {} }

  // Platform admin only: pick any business to see it exactly as its owner would, and test it.
  function switcher(opts) {
    const pl = opts.platform;
    if (!pl || !pl.businesses || !pl.businesses.length) return '';
    const testing = pl.activeId && pl.activeId !== pl.ownId;
    return `<div class="dogo-switch ${testing ? 'is-testing' : ''}">
      <label for="dogoBizSel">${testing ? 'Testing as' : 'Business'}</label>
      <select id="dogoBizSel">${pl.businesses.map(b => `<option value="${esc(b.id)}" ${b.id === pl.activeId ? 'selected' : ''}>${esc(b.name)} (${esc(b.business_type || '')})</option>`).join('')}</select>
      ${testing ? '<button type="button" id="dogoBizBack">Back to my business</button>' : ''}
    </div>`;
  }

  function renderNav(root, opts, tree) {
    const opened = openSet();
    const link = (i, sub) => `<a class="dogo-nav-item ${sub ? 'dogo-nav-sub' : ''} ${isCur(i.href) ? 'is-active' : ''}" href="${i.href}" title="${esc(i.label)}">
        <span class="dogo-nav-ico">${ICONS[i.icon] || ICONS.dot}</span><span class="dogo-nav-label">${esc(i.label)}</span></a>`;
    const node = n => {
      if (!n.children) return link(n, false);
      const hasActive = n.children.some(c => isCur(c.href));
      const open = hasActive || opened.includes(n.label);
      return `<div class="dogo-nav-group ${open ? 'is-open' : ''}" data-g="${esc(n.label)}">
        <button type="button" class="dogo-nav-item dogo-nav-parent ${hasActive ? 'has-active' : ''}" aria-expanded="${open}">
          <span class="dogo-nav-ico">${ICONS[n.icon] || ''}</span><span class="dogo-nav-label">${esc(n.label)}</span><span class="dogo-nav-chev">${ICONS.chevron}</span>
        </button>
        <div class="dogo-nav-children">${n.children.map(c => link(c, true)).join('')}</div>
      </div>`;
    };
    const who = opts.userName || opts.businessName || 'Dogo POS';
    root.innerHTML = `
      <nav class="dogo-nav-panel dogo-sidebar" id="dogoNavPanel" aria-label="Main menu">
        <div class="dogo-sidebar__brand">
          <span class="dogo-sidebar__logo"><img src="${esc(opts.logoUrl || 'icons/icon-192.png')}" alt="" onerror="this.onerror=null;this.src='icons/icon-192.png'"></span>
          <span class="dogo-sidebar__brand-text"><b>${esc(opts.businessName || 'Dogo POS')}</b><small>${esc(opts.typeLabel || '')}</small></span>
          <button class="dogo-sidebar__collapse" id="dogoCollapseBtn" aria-label="Collapse menu">${ICONS.collapse}</button>
          <button class="dogo-sidebar__close" id="dogoCloseBtn" aria-label="Close menu">&times;</button>
        </div>
        ${switcher(opts)}
        <div class="dogo-sidebar__scroll">${tree.map(node).join('')}</div>
        <div class="dogo-sidebar__user">
          <span class="dogo-avatar">${opts.avatarUrl ? `<img src="${esc(opts.avatarUrl)}" alt="" onerror="this.remove()">` : ""}<span>${esc(initials(who))}</span></span>
          <span class="dogo-sidebar__user-text"><b>${esc(who)}</b><small>${esc(opts.roleLabel || opts.typeLabel || '')}</small></span>
          <button type="button" class="dogo-sidebar__out" id="dogoSideOut" aria-label="Log out">${ICONS.logout}</button>
        </div>
      </nav>
      <div class="dogo-sidebar__backdrop" id="dogoNavBackdrop"></div>
    `;
    const back = root.querySelector('#dogoNavBackdrop');
    if (back) back.addEventListener('click', () => document.body.classList.remove('dogo-nav-open'));
    const col = root.querySelector('#dogoCollapseBtn');
    if (col) col.addEventListener('click', () => applyCollapsed(!document.body.classList.contains('dogo-sidebar-collapsed')));
    const sel = root.querySelector('#dogoBizSel');
    if (sel && typeof opts.onSwitch === 'function') sel.addEventListener('change', () => opts.onSwitch(sel.value === opts.platform.ownId ? null : sel.value));
    const backBtn = root.querySelector('#dogoBizBack');
    if (backBtn && typeof opts.onSwitch === 'function') backBtn.addEventListener('click', () => opts.onSwitch(null));
    window.addEventListener('hashchange', () => {
      root.querySelectorAll('a.dogo-nav-item').forEach(a => a.classList.toggle('is-active', isCur(a.getAttribute('href'))));
    });
    const cl = root.querySelector('#dogoCloseBtn');
    if (cl) cl.addEventListener('click', () => document.body.classList.remove('dogo-nav-open'));
    const out = root.querySelector('#dogoSideOut');
    if (out && typeof opts.onLogout === 'function') out.addEventListener('click', opts.onLogout);
    root.querySelectorAll('.dogo-nav-parent').forEach(b => b.addEventListener('click', () => {
      if (document.body.classList.contains('dogo-sidebar-collapsed') && window.innerWidth >= 900) applyCollapsed(false);
      const g = b.parentElement; const on = g.classList.toggle('is-open');
      b.setAttribute('aria-expanded', on);
      const set = openSet().filter(x => x !== g.dataset.g); if (on) set.push(g.dataset.g); saveOpen(set);
    }));
    root.querySelectorAll('a.dogo-nav-item').forEach(a => a.addEventListener('click', () => document.body.classList.remove('dogo-nav-open')));
  }

  window.DogoShell = {
    NAV_ITEMS,
    ICONS,
    typeKey,
    menuFor,
    THEMES,
    applyTheme,
    render(opts) {
      opts = opts || {};
      // businessType is optional: remember the last one so the very first paint
      // (before the session loads) already shows the right menu.
      if (opts.businessType) remember(opts.businessType);
      const raw = opts.businessType || rememberedType();
      const groups = menuFor(raw, opts.showTables, { platform: !!opts.platform, admin: opts.isAdmin !== false });
      opts.typeLabel = TYPE_LABEL[opts.showTables && !raw ? 'restaurant' : typeKey(raw)] || 'Business';
      document.body.classList.add('dogo-shell-v3', 'dogo-clay');
      applyTheme(opts.themeColor);
      if (isCollapsed()) document.body.classList.add('dogo-sidebar-collapsed');
      const headerRoot = document.getElementById('dogoHeaderRoot');
      const navRoot = document.getElementById('dogoNavRoot');
      if (headerRoot) renderHeader(headerRoot, opts, groups);
      if (navRoot) renderNav(navRoot, opts, groups);
    }
  };
})();
