/* Dogo POS - business-type profiles.
   One place that decides which categories, item types and wording each kind of
   business sees in forms. Pages ask DogoBiz.profileFor(business.business_type).

   Restaurant categories are deliberately drawn from the food list already used by
   sell.html / orders.html (BREAKFAST, DRINKS, LUNCH, DINNER/SUPPER, SNACKS, ...) so
   that anything saved here shows up on the restaurant till and order desk.
   The stored item type stays 'Product' or 'Service' (that is what the database
   expects) - only the wording shown to the user changes. */
(function () {
  const TYPES_GOODS = [{ value: 'Product', label: 'Product' }, { value: 'Service', label: 'Service' }];

  const PROFILES = {
    supermarket: {
      key: 'supermarket', label: 'Supermarket',
      categories: ['Fresh Produce', 'Meat & Fish', 'Dairy & Eggs', 'Bakery', 'Groceries & Staples', 'Cooking Oil & Fats',
        'Beverages', 'Snacks & Confectionery', 'Frozen Foods', 'Household & Cleaning', 'Personal Care',
        'Baby Products', 'Stationery', 'Airtime & Mobile Money', 'General'],
      types: TYPES_GOODS, defaultType: 'Product',
      itemWord: 'Item', nameLabel: 'Product name', namePlaceholder: 'e.g. Brookside Milk 500ml',
      stockLabel: 'Initial stock (units)', reorderLabel: 'Reorder threshold',
      descPlaceholder: 'Brand, size, pack details...',
      subtitle: 'Add a new product to your supermarket catalogue',
      pageTitle: 'Product Catalogue', addLabel: 'New Product'
    },
    hardware: {
      key: 'hardware', label: 'Hardware Store',
      categories: ['Cement & Building', 'Iron Sheets & Roofing', 'Steel, Wire & Nails', 'Timber & Boards', 'Paint & Finishes',
        'Plumbing & Pipes', 'Electrical', 'Tools & Equipment', 'Fasteners & Fittings', 'Doors, Windows & Locks',
        'Tiles & Flooring', 'Safety & Workwear', 'Garden & Farm', 'General'],
      types: [{ value: 'Product', label: 'Material / Tool' }, { value: 'Service', label: 'Service (delivery, cutting, fitting)' }],
      defaultType: 'Product',
      itemWord: 'Item', nameLabel: 'Item name', namePlaceholder: 'e.g. Bamburi Cement 50kg',
      stockLabel: 'Initial stock (pcs / bags / lengths)', reorderLabel: 'Reorder threshold',
      descPlaceholder: 'Size, grade, brand, gauge...',
      subtitle: 'Add a new material, tool or service to your catalogue',
      pageTitle: 'Stock Catalogue', addLabel: 'New Item'
    },
    restaurant: {
      key: 'restaurant', label: 'Hotel / Restaurant',
      // every one of these is recognised as food by the restaurant till and order desk
      categories: ['Breakfast', 'Lunch', 'Dinner/Supper', 'Starters', 'Soups', 'Snacks', 'Desserts', 'Specials', 'Combos',
        'Drinks', 'Soft Drinks', 'Juices', 'Hot Beverages'],
      types: [{ value: 'Product', label: 'Menu item' }, { value: 'Service', label: 'Service charge (e.g. delivery, corkage)' }],
      defaultType: 'Product',
      itemWord: 'Menu Item', nameLabel: 'Menu item', namePlaceholder: 'e.g. Chicken Biryani',
      stockLabel: 'Portions available', reorderLabel: 'Low-portion alert',
      descPlaceholder: 'Ingredients, serving size, allergens...',
      subtitle: 'Add a dish or drink to your menu',
      pageTitle: 'Menu & Catalogue', addLabel: 'New Menu Item'
    },
    kiosk: {
      key: 'kiosk', label: 'Kiosk / Kibanda',
      categories: ['Milk & Dairy', 'Bread & Bakery', 'Eggs', 'Soft Drinks', 'Water & Juice', 'Snacks', 'Sweets & Biscuits',
        'Airtime & Data', 'Mobile Money', 'Household Basics', 'General'],
      types: [{ value: 'Product', label: 'Product' }, { value: 'Service', label: 'Service (airtime, M-Pesa, charging)' }],
      defaultType: 'Product',
      itemWord: 'Item', nameLabel: 'Item name', namePlaceholder: 'e.g. Fresh Milk 500ml',
      stockLabel: 'Initial stock', reorderLabel: 'Reorder threshold',
      descPlaceholder: 'Optional note...',
      subtitle: 'Add a quick-sell item to your kiosk',
      pageTitle: 'Kiosk Items', addLabel: 'New Item'
    },
    wholesale: {
      key: 'wholesale', label: 'Wholesale',
      categories: ['Grains & Cereals', 'Sugar & Flour', 'Cooking Oil & Fats', 'Beverages (Cartons)', 'Bulk Sacks & Bales',
        'Cartons & Cases', 'Household Goods', 'Packaging', 'Personal Care', 'General'],
      types: [{ value: 'Product', label: 'Bulk product' }, { value: 'Service', label: 'Service (transport, packing)' }],
      defaultType: 'Product',
      itemWord: 'Item', nameLabel: 'Product name', namePlaceholder: 'e.g. Maize Flour 24 x 2kg carton',
      stockLabel: 'Initial stock (cartons / sacks)', reorderLabel: 'Reorder threshold',
      descPlaceholder: 'Pack size, units per carton, brand...',
      subtitle: 'Add a bulk product to your wholesale catalogue',
      pageTitle: 'Wholesale Catalogue', addLabel: 'New Product'
    },
    sme: {
      key: 'sme', label: 'SME / General Business',
      categories: ['Consulting', 'Professional Services', 'Repairs & Maintenance', 'Subscriptions & Retainers',
        'Training', 'Supplies & Materials', 'Products', 'General'],
      types: [{ value: 'Service', label: 'Service' }, { value: 'Product', label: 'Product' }],
      defaultType: 'Service',
      itemWord: 'Item', nameLabel: 'Item / service name', namePlaceholder: 'e.g. Monthly bookkeeping',
      stockLabel: 'Initial stock (products only)', reorderLabel: 'Reorder threshold',
      descPlaceholder: 'What is included...',
      subtitle: 'Add a service or product to your price list',
      pageTitle: 'Services & Products', addLabel: 'New Item'
    },
    retail: {
      key: 'retail', label: 'Retail Shop',
      categories: ['Clothing', 'Shoes', 'Accessories', 'Bags', 'Electronics', 'Phones & Accessories', 'Cosmetics & Beauty',
        'Home & Kitchen', 'Stationery', 'Toys & Gifts', 'General'],
      types: TYPES_GOODS, defaultType: 'Product',
      itemWord: 'Item', nameLabel: 'Product name', namePlaceholder: 'e.g. Men\'s Polo Shirt - Blue (M)',
      stockLabel: 'Initial stock', reorderLabel: 'Reorder threshold',
      descPlaceholder: 'Size, colour, brand...',
      subtitle: 'Add a new product to your shop catalogue',
      pageTitle: 'Product Catalogue', addLabel: 'New Product'
    }
  };

  // Stock units. The value 'piece' is always the first (default) entry: receipts hide it, the
  // database defaults to it, and only 'kg' / 'litre' are treated as fractional quantities.
  const U = (...pairs) => pairs.map(p => ({ value: p[0], label: p[1] }));
  const UNITS = {
    supermarket: U(['piece', 'Piece'], ['pack', 'Pack'], ['kg', 'Kilogram (kg)'], ['g', 'Gram (g)'], ['litre', 'Litre'], ['box', 'Carton / box']),
    hardware: U(['piece', 'Piece'], ['bag', 'Bag'], ['kg', 'Kilogram (kg)'], ['litre', 'Litre'], ['metre', 'Metre'],
      ['length', 'Length (bar / pipe / timber)'], ['sheet', 'Sheet'], ['roll', 'Roll'], ['bundle', 'Bundle'], ['box', 'Box / carton']),
    restaurant: U(['piece', 'Portion / plate'], ['cup', 'Cup'], ['glass', 'Glass'], ['bottle', 'Bottle'], ['litre', 'Litre'], ['kg', 'Kilogram (kg)']),
    kiosk: U(['piece', 'Piece'], ['pack', 'Pack'], ['bottle', 'Bottle'], ['sachet', 'Sachet'], ['litre', 'Litre'], ['kg', 'Kilogram (kg)']),
    wholesale: U(['piece', 'Piece'], ['carton', 'Carton'], ['sack', 'Sack'], ['bale', 'Bale'], ['dozen', 'Dozen'], ['pack', 'Pack'],
      ['kg', 'Kilogram (kg)'], ['litre', 'Litre']),
    sme: U(['piece', 'Unit / job'], ['hour', 'Hour'], ['day', 'Day'], ['session', 'Session'], ['month', 'Month']),
    retail: U(['piece', 'Piece'], ['pair', 'Pair'], ['set', 'Set'], ['pack', 'Pack'], ['box', 'Box'])
  };

  // Expense categories. 'Stock Purchases' must stay in every list (purchases.html books to it by
  // that exact value) and 'Other' closes each list.
  const SP = { value: 'Stock Purchases', label: 'Stock Purchases' };
  const EXPENSES = {
    supermarket: ['Rent', 'Utilities', SP, 'Salaries', 'Packaging & Bags', 'Refrigeration & Repairs', 'Security', 'Transport & Delivery',
      'Licenses', 'POS & Equipment', 'Marketing', 'Petty Cash', 'Other'],
    hardware: ['Rent', 'Utilities', SP, 'Salaries', 'Transport & Delivery', 'Loading & Offloading', 'Yard & Storage', 'Equipment & Tools',
      'Licenses', 'Marketing', 'Petty Cash', 'Other'],
    restaurant: ['Rent', 'Utilities', { value: 'Stock Purchases', label: 'Stock Purchases (ingredients & supplies)' }, 'Salaries',
      'Gas & Fuel', 'Kitchen Equipment', 'Cleaning & Laundry', 'Licenses & Permits', 'Transport', 'Marketing', 'Petty Cash', 'Other'],
    kiosk: ['Rent / Stall Fees', 'Utilities', SP, 'Transport', 'Airtime & Data', 'Licenses', 'Petty Cash', 'Other'],
    wholesale: ['Rent', 'Utilities', SP, 'Salaries', 'Freight & Transport', 'Warehousing', 'Loading & Offloading', 'Licenses',
      'Equipment', 'Marketing', 'Petty Cash', 'Other'],
    sme: ['Rent', 'Utilities', SP, 'Salaries', 'Software & Subscriptions', 'Professional Fees', 'Travel & Transport', 'Licenses',
      'Equipment', 'Marketing', 'Petty Cash', 'Other'],
    retail: ['Rent', 'Utilities', SP, 'Salaries', 'Shop Fittings & Display', 'Packaging', 'Transport', 'Licenses', 'Equipment',
      'Marketing', 'Petty Cash', 'Other']
  };
  Object.keys(PROFILES).forEach(k => { PROFILES[k].units = UNITS[k]; PROFILES[k].expenseCategories = EXPENSES[k]; });

  // Accepts either the short signup value ("Hotel", "Hardware", "SME") or the long label
  // ("Hotel / Restaurant", "Hardware Store", "SME / General Business").
  function profileFor(rawType) {
    const t = String(rawType || '').toLowerCase();
    if (t.includes('hotel') || t.includes('restaurant')) return PROFILES.restaurant;
    if (t.includes('hardware')) return PROFILES.hardware;
    if (t.includes('supermarket')) return PROFILES.supermarket;
    if (t.includes('wholesale')) return PROFILES.wholesale;
    if (t.includes('kiosk') || t.includes('kibanda')) return PROFILES.kiosk;
    if (t.includes('sme') || t.includes('general')) return PROFILES.sme;
    return PROFILES.retail;
  }

  // Fill a <select> from a list of {value,label} or plain strings.
  // keepValue: an already-saved value that is not in the list stays selectable, so editing an
  // older item never silently blanks or changes its category.
  function fillSelect(sel, items, opts) {
    opts = opts || {};
    const previous = opts.preserve ? sel.value : null;   // keep the current choice across a re-fill
    const frag = document.createDocumentFragment();
    const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; frag.appendChild(o); };
    if (opts.placeholder) add('', opts.placeholder);
    const seen = new Set();
    items.forEach(it => { const v = typeof it === 'string' ? it : it.value, l = typeof it === 'string' ? it : it.label; seen.add(v); add(v, l); });
    if (opts.keepValue && !seen.has(opts.keepValue)) add(opts.keepValue, opts.keepValue + ' (existing)');
    sel.innerHTML = '';
    sel.appendChild(frag);
    if (previous && seen.has(previous)) sel.value = previous;
  }

  // Set a <select> to a saved value even if the current list does not include it (e.g. an older
  // item saved with a unit or category from before), so editing never blanks or changes it.
  function setValue(sel, value) {
    if (value == null || value === '') { sel.value = ''; return; }
    if (![...sel.options].some(o => o.value === value)) {
      const o = document.createElement('option'); o.value = value; o.textContent = value + ' (existing)'; sel.appendChild(o);
    }
    sel.value = value;
  }

  window.DogoBiz = { PROFILES, profileFor, fillSelect, setValue };
})();
