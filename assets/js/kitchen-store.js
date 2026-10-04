/* Kitchen tickets for the new-layout restaurant pages.
   Shared across devices through public.kitchen_tickets (see
   supabase/migrations/20261004_kitchen_tickets.sql). If that migration has not been run yet,
   everything keeps working on THIS device only (localStorage) and `DogoKitchen.mode` says so,
   so the pages can warn the user instead of silently splitting orders between devices. */
(function () {
  const LOCAL_KEY = 'dogopos_kitchen_tickets_v1';   // same key the classic app uses
  let sb = null, businessId = null, mode = 'unknown';  // 'db' | 'local'

  const rowToTicket = r => ({
    id: r.id, shortId: r.short_id, orderType: r.order_type, table: r.table_name || '', location: r.location || '',
    status: r.status, items: r.items || [], total: Number(r.total || 0), paid: !!r.paid, saleId: r.sale_id || null,
    createdAt: r.created_at
  });
  const readLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; } };
  const writeLocal = t => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(t)); } catch (e) {} };
  // classic-app tickets use {id:'POS-XXXX', shortId, orderType, status, items, paid, createdAt, location}
  const localToTicket = t => ({
    id: t.id, shortId: t.shortId, orderType: t.orderType || 'DINE IN', table: t.table || '', location: t.location || '',
    status: t.status, items: t.items || [], paid: !!t.paid, saleId: t.saleId || null, createdAt: t.createdAt || null,
    total: (t.items || []).reduce((a, i) => a + Number(i.price || 0) * Number(i.qty || 0), 0)
  });

  async function init(client, bizId) {
    sb = client; businessId = bizId;
    const { error } = await sb.from('kitchen_tickets').select('id', { head: true, count: 'exact' }).limit(1);
    mode = error ? 'local' : 'db';
    return mode;
  }

  async function list() {
    if (mode === 'db') {
      const { data, error } = await sb.from('kitchen_tickets').select('*')
        .neq('status', 'cancelled').order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      return (data || []).filter(r => !(r.status === 'served' && r.paid)).map(rowToTicket);
    }
    return readLocal().filter(t => t.status !== 'cancelled' && !(t.status === 'served' && t.paid)).map(localToTicket);
  }

  async function create({ orderType, table, location, items }) {
    const total = items.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
    const shortId = '#' + Math.floor(1000 + Math.random() * 9000);
    if (mode === 'db') {
      const { data: { session } } = await sb.auth.getSession();
      const { data, error } = await sb.from('kitchen_tickets').insert({
        business_id: businessId, short_id: shortId, order_type: orderType, table_name: table || null, location: location || null,
        items, total, created_by: session && session.user ? session.user.id : null
      }).select().single();
      if (error) throw error;
      return rowToTicket(data);
    }
    const t = { id: 'POS-' + Math.random().toString(36).substring(2, 10).toUpperCase(), shortId, orderType: orderType.toUpperCase(),
      priority: 'MEDIUM PRIORITY', location: location || 'Main', status: 'pending', createdAt: new Date().toISOString(), timeMin: 0,
      paymentStatus: 'Unpaid KES ' + total.toFixed(2), table: table || '', items: JSON.parse(JSON.stringify(items)) };
    const all = readLocal(); all.unshift(t); writeLocal(all);
    return localToTicket(t);
  }

  async function setStatus(id, status) {
    if (mode === 'db') {
      const { error } = await sb.from('kitchen_tickets').update({ status }).eq('id', id);
      if (error) throw error; return;
    }
    const all = readLocal(); const t = all.find(x => x.id === id); if (t) { t.status = status; writeLocal(all); }
  }

  async function markPaid(id, saleId) {
    if (mode === 'db') {
      const { error } = await sb.from('kitchen_tickets').update({ paid: true, sale_id: saleId || null }).eq('id', id);
      if (error) throw error; return;
    }
    const all = readLocal(); const t = all.find(x => x.id === id);
    if (t) { t.paid = true; t.paymentStatus = 'Paid'; if (saleId) t.saleId = saleId; writeLocal(all); }
  }

  // Calls back whenever any ticket for this business changes (DB mode); polls every 15s in local mode.
  function subscribe(onChange) {
    let timer = null, ch = null;
    if (mode === 'db' && sb.channel) {
      try {
        ch = sb.channel('kitchen-' + businessId)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchen_tickets', filter: 'business_id=eq.' + businessId }, () => onChange())
          .subscribe();
      } catch (e) { ch = null; }
    }
    timer = setInterval(onChange, ch ? 60000 : 15000);   // safety net even with realtime
    window.addEventListener('storage', e => { if (e.key === LOCAL_KEY) onChange(); });
    return () => { clearInterval(timer); if (ch) try { sb.removeChannel(ch); } catch (e) {} };
  }

  const elapsedMin = t => t.createdAt ? Math.max(0, Math.round((Date.now() - new Date(t.createdAt).getTime()) / 60000)) : 0;

  window.DogoKitchen = {
    init, list, create, setStatus, markPaid, subscribe, elapsedMin,
    get mode() { return mode; }
  };
})();
