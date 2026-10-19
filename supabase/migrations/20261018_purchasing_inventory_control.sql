-- Dogo POS — Stage 1: purchasing + inventory control.
--   * suppliers, purchase_orders, supplier_payments   (were browser-only localStorage until now)
--   * stock_movements  = the kardex: every stock change, with who/why/what balance
--   * product_cost_history = every change of a product's buying price
--   * stock_counts / stock_count_items = counted vs system quantities, adjusted on finalize
--   * product_lots (batch + expiry, consumed first-expiry-first-out on sale) and product_serials
-- Additive and safe to re-run. NOT yet applied to production: review, then run in the Supabase SQL editor.
-- Assumes (as the app already does): current_business_id(), is_admin(), profiles(id = auth.uid(), role),
-- products(stock, cost, archived), sale_items(sale_id, product_id, qty), expenses(business_id, category, description, amount, vat_rate, created_by).

-- ---------------------------------------------------------------------------------------------
-- 0. Product flags
-- ---------------------------------------------------------------------------------------------
alter table public.products add column if not exists track_lots    boolean not null default false;
alter table public.products add column if not exists track_serials boolean not null default false;

-- helper: admin or manager of the signed-in user's business
create or replace function public.stock_is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.is_admin(), false)
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin','manager'));
$$;
revoke all on function public.stock_is_manager() from public, anon;
grant execute on function public.stock_is_manager() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Suppliers, purchase orders, supplier payments
-- ---------------------------------------------------------------------------------------------
create table if not exists public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  phone       text,
  email       text,
  pin         text,
  created_at  timestamptz not null default now()
);
create unique index if not exists suppliers_business_name_uq on public.suppliers (business_id, lower(name));

create table if not exists public.purchase_orders (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  ref_no         text not null,
  supplier_id    uuid references public.suppliers(id) on delete set null,
  supplier_name  text not null,
  supplier_phone text,
  invoice_no     text,
  status         text not null default 'Received',
  payment_status text not null default 'Unpaid' check (payment_status in ('Unpaid','Part-paid','Paid')),
  total_amount   numeric(12,2) not null default 0 check (total_amount >= 0),
  paid_amount    numeric(12,2) not null default 0 check (paid_amount >= 0),
  vat            numeric(12,2) not null default 0,
  due_date       date,
  po_date        date not null default current_date,
  items          jsonb not null default '[]'::jsonb,   -- [{productId,name,qty,unitCost,total,lot,expiry,serials}]
  notes          text,
  source         text,                                 -- 'manual' | 'invoice-scan' | 'local-import'
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (business_id, ref_no)
);
create index if not exists purchase_orders_business_idx on public.purchase_orders (business_id, created_at desc);
create index if not exists purchase_orders_supplier_idx on public.purchase_orders (supplier_id);

create table if not exists public.supplier_payments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  po_id         uuid not null references public.purchase_orders(id) on delete cascade,
  supplier_id   uuid references public.suppliers(id) on delete set null,
  supplier_name text,
  amount        numeric(12,2) not null check (amount > 0),
  method        text not null default 'Cash',
  reference     text,
  expense_id    uuid,
  paid_at       timestamptz not null default now(),
  created_by    uuid
);
create index if not exists supplier_payments_po_idx on public.supplier_payments (po_id);
create index if not exists supplier_payments_business_idx on public.supplier_payments (business_id, paid_at desc);

-- ---------------------------------------------------------------------------------------------
-- 2. Lots and serials
-- ---------------------------------------------------------------------------------------------
create table if not exists public.product_lots (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  product_id    uuid not null references public.products(id) on delete cascade,
  lot_no        text,
  expiry_date   date,
  qty_received  numeric not null check (qty_received >= 0),
  qty_remaining numeric not null check (qty_remaining >= 0),
  unit_cost     numeric,
  po_id         uuid references public.purchase_orders(id) on delete set null,
  received_at   timestamptz not null default now()
);
create index if not exists product_lots_product_idx on public.product_lots (product_id, expiry_date nulls last);
create index if not exists product_lots_business_expiry_idx on public.product_lots (business_id, expiry_date) where qty_remaining > 0;

create table if not exists public.product_serials (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  serial_no   text not null,
  lot_id      uuid references public.product_lots(id) on delete set null,
  po_id       uuid references public.purchase_orders(id) on delete set null,
  status      text not null default 'in_stock' check (status in ('in_stock','sold','returned','written_off')),
  sale_id     uuid,
  note        text,
  received_at timestamptz not null default now(),
  unique (business_id, product_id, serial_no)
);
create index if not exists product_serials_product_idx on public.product_serials (product_id, status);

-- ---------------------------------------------------------------------------------------------
-- 3. Kardex (stock movements) and cost history
--    Written by triggers, so every existing path (till sales, catalogue edits, restock, scanned
--    invoices) is covered without touching process_sale. Reason/ref come from transaction-local
--    settings that the RPCs below (and the sale_items trigger) set.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id            bigint generated always as identity primary key,
  business_id   uuid not null references public.businesses(id) on delete cascade,
  product_id    uuid not null references public.products(id) on delete cascade,
  lot_id        uuid references public.product_lots(id) on delete set null,
  type          text not null check (type in ('opening','purchase','sale','adjustment','count','return')),
  qty_change    numeric not null,
  balance_after numeric,
  unit_cost     numeric,
  ref_type      text,
  ref_id        text,
  note          text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  txid          bigint not null default txid_current()
);
create index if not exists stock_movements_product_idx  on public.stock_movements (product_id, created_at desc);
create index if not exists stock_movements_business_idx on public.stock_movements (business_id, created_at desc);
create index if not exists stock_movements_txn_idx      on public.stock_movements (txid, product_id);

create table if not exists public.product_cost_history (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  old_cost    numeric,
  new_cost    numeric not null,
  reason      text,
  ref_id      text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists product_cost_history_product_idx on public.product_cost_history (product_id, created_at desc);

create or replace function public.trg_products_stock_move() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_type text; v_ref text; v_reason text;
begin
  v_reason := nullif(current_setting('app.stock_reason', true), '');
  v_ref    := nullif(current_setting('app.stock_ref', true), '');
  if tg_op = 'INSERT' then
    if coalesce(new.stock, 0) <> 0 then
      insert into public.stock_movements (business_id, product_id, type, qty_change, balance_after, unit_cost, note)
      values (new.business_id, new.id, 'opening', new.stock, new.stock, new.cost, 'Opening stock');
    end if;
    if new.cost is not null then
      insert into public.product_cost_history (business_id, product_id, old_cost, new_cost, reason)
      values (new.business_id, new.id, null, new.cost, 'opening');
    end if;
  else
    if new.stock is distinct from old.stock then
      v_type := case when v_reason in ('purchase','sale','count','return') then v_reason else 'adjustment' end;
      insert into public.stock_movements (business_id, product_id, lot_id, type, qty_change, balance_after, unit_cost, ref_type, ref_id, note)
      values (new.business_id, new.id, nullif(current_setting('app.stock_lot', true), '')::uuid, v_type,
              coalesce(new.stock, 0) - coalesce(old.stock, 0), new.stock, new.cost,
              case when v_ref is not null then v_type end, v_ref,
              coalesce(nullif(current_setting('app.stock_note', true), ''), case when v_type = 'adjustment' then 'Stock edited' end));
    end if;
    if new.cost is distinct from old.cost and new.cost is not null then
      insert into public.product_cost_history (business_id, product_id, old_cost, new_cost, reason, ref_id)
      values (new.business_id, new.id, old.cost, new.cost, coalesce(v_reason, 'manual'), v_ref);
    end if;
  end if;
  return new;
end $$;
revoke all on function public.trg_products_stock_move() from public, anon, authenticated;

drop trigger if exists trg_products_stock_move_ins on public.products;
create trigger trg_products_stock_move_ins after insert on public.products
  for each row execute function public.trg_products_stock_move();
drop trigger if exists trg_products_stock_move_upd on public.products;
create trigger trg_products_stock_move_upd after update of stock, cost on public.products
  for each row execute function public.trg_products_stock_move();

-- Sales: label the movement as a sale (works whichever order process_sale inserts items and
-- decrements stock in) and consume lots first-expiry-first-out for lot-tracked products.
create or replace function public.trg_sale_items_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_track boolean; v_left numeric; r record; v_take numeric;
begin
  if new.product_id is null then return new; end if;
  -- (a) stock already decremented earlier in this transaction: relabel that movement
  update public.stock_movements
     set type = 'sale', ref_type = 'sale', ref_id = new.sale_id::text, note = null
   where txid = txid_current() and product_id = new.product_id and type = 'adjustment' and ref_id is null;
  -- (b) stock not decremented yet: tag the upcoming change
  perform set_config('app.stock_reason', 'sale', true);
  perform set_config('app.stock_ref', new.sale_id::text, true);

  select track_lots into v_track from public.products where id = new.product_id;
  if coalesce(v_track, false) then
    v_left := coalesce(new.qty, 0);
    for r in select id, qty_remaining from public.product_lots
              where product_id = new.product_id and qty_remaining > 0
              order by expiry_date nulls last, received_at, id
              for update loop
      exit when v_left <= 0;
      v_take := least(r.qty_remaining, v_left);
      update public.product_lots set qty_remaining = qty_remaining - v_take where id = r.id;
      v_left := v_left - v_take;
    end loop;
  end if;
  return new;
end $$;
revoke all on function public.trg_sale_items_stock() from public, anon, authenticated;

drop trigger if exists trg_sale_items_stock on public.sale_items;
create trigger trg_sale_items_stock after insert on public.sale_items
  for each row execute function public.trg_sale_items_stock();

-- ---------------------------------------------------------------------------------------------
-- 4. Receiving stock (purchase orders and scanned invoices) in one atomic call
--    p_items: [{product_id, qty, unit_cost, lot_no, expiry, serials:[...]}]
--    qty and unit_cost are already in the product's base unit (the page converts bulk packs).
--    Adds to the CURRENT stock, keeps buying price as a weighted average, records lots/serials.
-- ---------------------------------------------------------------------------------------------
create or replace function public.receive_stock(p_business_id uuid, p_items jsonb, p_po_id uuid default null)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  it jsonb; v_pid uuid; v_qty numeric; v_cost numeric; v_lot text; v_exp date; v_serials text[];
  v_prod record; v_new_stock numeric; v_new_cost numeric; v_lot_id uuid; n integer := 0; s text;
begin
  if p_business_id is distinct from current_business_id() then raise exception 'Not your business'; end if;
  perform set_config('app.stock_reason', 'purchase', true);
  perform set_config('app.stock_ref', coalesce(p_po_id::text, ''), true);
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_pid  := (it->>'product_id')::uuid;
    v_qty  := coalesce((it->>'qty')::numeric, 0);
    v_cost := nullif(it->>'unit_cost', '')::numeric;
    v_lot  := nullif(btrim(coalesce(it->>'lot_no', '')), '');
    v_exp  := nullif(it->>'expiry', '')::date;
    v_serials := coalesce(array(select btrim(x) from jsonb_array_elements_text(coalesce(it->'serials', '[]'::jsonb)) x where btrim(x) <> ''), '{}');
    continue when v_pid is null or v_qty <= 0;

    select id, stock, cost, track_lots, track_serials into v_prod
      from public.products where id = v_pid and business_id = p_business_id for update;
    if not found then raise exception 'Product not found'; end if;
    if coalesce(array_length(v_serials, 1), 0) > 0 and array_length(v_serials, 1) <> v_qty then
      raise exception 'Enter exactly % serial numbers (got %)', v_qty, array_length(v_serials, 1);
    end if;

    v_lot_id := null;
    if v_lot is not null or v_exp is not null or coalesce(v_prod.track_lots, false) then
      insert into public.product_lots (business_id, product_id, lot_no, expiry_date, qty_received, qty_remaining, unit_cost, po_id)
      values (p_business_id, v_pid, v_lot, v_exp, v_qty, v_qty, v_cost, p_po_id) returning id into v_lot_id;
    end if;

    v_new_stock := coalesce(v_prod.stock, 0) + v_qty;
    v_new_cost  := v_prod.cost;
    if v_cost is not null and v_cost > 0 then
      v_new_cost := round(case when v_prod.cost is not null and coalesce(v_prod.stock, 0) > 0
                               then (v_prod.stock * v_prod.cost + v_qty * v_cost) / v_new_stock
                               else v_cost end, 2);
    end if;
    -- the products trigger copies these onto the kardex row it writes
    perform set_config('app.stock_lot', coalesce(v_lot_id::text, ''), true);
    perform set_config('app.stock_note', coalesce(concat_ws(' · ', 'Lot ' || v_lot, 'exp ' || v_exp::text), ''), true);
    update public.products set stock = v_new_stock, cost = v_new_cost where id = v_pid;
    perform set_config('app.stock_lot', '', true);
    perform set_config('app.stock_note', '', true);

    foreach s in array v_serials loop
      insert into public.product_serials (business_id, product_id, serial_no, lot_id, po_id) values (p_business_id, v_pid, s, v_lot_id, p_po_id);
    end loop;
    n := n + 1;
  end loop;
  return n;
exception when unique_violation then
  raise exception 'A serial number you entered is already in stock for that product';
end $$;
revoke all on function public.receive_stock(uuid, jsonb, uuid) from public, anon;
grant execute on function public.receive_stock(uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Supplier payments: partial or full, atomic (payment row + expense + PO balance together)
-- ---------------------------------------------------------------------------------------------
create or replace function public.record_supplier_payment(
  p_po_id uuid, p_amount numeric, p_method text default 'Cash', p_reference text default null, p_created_by uuid default null)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  po record; v_balance numeric; v_exp uuid; v_pay uuid;
begin
  select * into po from public.purchase_orders where id = p_po_id and business_id = current_business_id() for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero'; end if;
  v_balance := po.total_amount - po.paid_amount;
  if p_amount > v_balance + 0.005 then
    raise exception 'That is more than the balance owed (%)', to_char(v_balance, 'FM999,999,990.00');
  end if;

  insert into public.expenses (business_id, category, description, amount, vat_rate, created_by)
  values (po.business_id, 'Stock Purchases',
          'Supplier payment: ' || po.supplier_name || ' [' || po.ref_no || ']' || coalesce(' - ' || nullif(p_reference, ''), ''),
          p_amount, 0, p_created_by)
  returning id into v_exp;

  insert into public.supplier_payments (business_id, po_id, supplier_id, supplier_name, amount, method, reference, expense_id, created_by)
  values (po.business_id, po.id, po.supplier_id, po.supplier_name, p_amount, coalesce(nullif(p_method, ''), 'Cash'), nullif(p_reference, ''), v_exp, p_created_by)
  returning id into v_pay;

  update public.purchase_orders
     set paid_amount = paid_amount + p_amount,
         payment_status = case when paid_amount + p_amount >= total_amount - 0.005 then 'Paid' else 'Part-paid' end
   where id = po.id;
  return v_pay;
end $$;
revoke all on function public.record_supplier_payment(uuid, numeric, text, text, uuid) from public, anon;
grant execute on function public.record_supplier_payment(uuid, numeric, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. Stock counts
--    start: snapshots the system quantity per product. finalize: adds (counted - snapshot) to the
--    live stock, so sales made while counting are not overwritten. Admin/manager only.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.stock_counts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  name         text not null,
  status       text not null default 'open' check (status in ('open','finalized','cancelled')),
  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  finalized_at timestamptz,
  finalized_by uuid
);
create table if not exists public.stock_count_items (
  id           uuid primary key default gen_random_uuid(),
  count_id     uuid not null references public.stock_counts(id) on delete cascade,
  business_id  uuid not null references public.businesses(id) on delete cascade,
  product_id   uuid not null references public.products(id) on delete cascade,
  product_name text,
  system_qty   numeric not null default 0,
  counted_qty  numeric check (counted_qty is null or counted_qty >= 0),
  unique (count_id, product_id)
);
create index if not exists stock_counts_business_idx on public.stock_counts (business_id, created_at desc);
create index if not exists stock_count_items_count_idx on public.stock_count_items (count_id);

create or replace function public.start_stock_count(p_business_id uuid, p_name text, p_product_ids uuid[] default null, p_created_by uuid default null)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare v_id uuid;
begin
  if p_business_id is distinct from current_business_id() then raise exception 'Not your business'; end if;
  if not public.stock_is_manager() then raise exception 'Only an admin or manager can start a stock count'; end if;
  insert into public.stock_counts (business_id, name, created_by)
  values (p_business_id, coalesce(nullif(btrim(p_name), ''), 'Stock count ' || to_char(now(), 'YYYY-MM-DD')), p_created_by)
  returning id into v_id;
  insert into public.stock_count_items (count_id, business_id, product_id, product_name, system_qty)
  select v_id, p_business_id, p.id, p.name, coalesce(p.stock, 0)
    from public.products p
   where p.business_id = p_business_id and not coalesce(p.archived, false)
     and (p_product_ids is null or p.id = any (p_product_ids));
  return v_id;
end $$;
revoke all on function public.start_stock_count(uuid, text, uuid[], uuid) from public, anon;
grant execute on function public.start_stock_count(uuid, text, uuid[], uuid) to authenticated;

create or replace function public.finalize_stock_count(p_count_id uuid, p_user uuid default null)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  c record; r record; v_adj integer := 0; v_short numeric := 0; v_over numeric := 0; v_delta numeric;
begin
  if not public.stock_is_manager() then raise exception 'Only an admin or manager can finalize a stock count'; end if;
  select * into c from public.stock_counts where id = p_count_id and business_id = current_business_id() for update;
  if not found then raise exception 'Stock count not found'; end if;
  if c.status <> 'open' then raise exception 'This count is already %', c.status; end if;
  perform set_config('app.stock_reason', 'count', true);
  perform set_config('app.stock_ref', c.id::text, true);
  for r in select * from public.stock_count_items where count_id = c.id and counted_qty is not null and counted_qty <> system_qty loop
    v_delta := r.counted_qty - r.system_qty;
    update public.products set stock = greatest(0, coalesce(stock, 0) + v_delta) where id = r.product_id and business_id = c.business_id;
    v_adj := v_adj + 1;
    if v_delta < 0 then v_short := v_short + v_delta; else v_over := v_over + v_delta; end if;
  end loop;
  update public.stock_counts set status = 'finalized', finalized_at = now(), finalized_by = p_user where id = c.id;
  return jsonb_build_object('adjusted', v_adj, 'short_units', v_short, 'over_units', v_over);
end $$;
revoke all on function public.finalize_stock_count(uuid, uuid) from public, anon;
grant execute on function public.finalize_stock_count(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6b. Write off what is left of a lot (expired / damaged): stock and lot go down together
-- ---------------------------------------------------------------------------------------------
create or replace function public.write_off_lot(p_lot_id uuid, p_note text default null)
returns numeric
language plpgsql security invoker set search_path = public as $$
declare l record;
begin
  if not public.stock_is_manager() then raise exception 'Only an admin or manager can write off stock'; end if;
  select * into l from public.product_lots where id = p_lot_id and business_id = current_business_id() for update;
  if not found then raise exception 'Lot not found'; end if;
  if l.qty_remaining <= 0 then raise exception 'Nothing left in this lot'; end if;
  perform set_config('app.stock_reason', 'adjustment', true);
  perform set_config('app.stock_ref', '', true);
  perform set_config('app.stock_lot', l.id::text, true);
  perform set_config('app.stock_note', 'Write-off: ' || coalesce('lot ' || l.lot_no, 'lot') || coalesce(' · ' || nullif(btrim(p_note), ''), ''), true);
  update public.products set stock = greatest(0, coalesce(stock, 0) - l.qty_remaining) where id = l.product_id and business_id = l.business_id;
  update public.product_lots set qty_remaining = 0 where id = l.id;
  perform set_config('app.stock_lot', '', true);
  perform set_config('app.stock_note', '', true);
  return l.qty_remaining;
end $$;
revoke all on function public.write_off_lot(uuid, text) from public, anon;
grant execute on function public.write_off_lot(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Row level security (same business-scoped pattern as kitchen_tickets)
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['suppliers','purchase_orders','supplier_payments','product_lots','product_serials','stock_counts','stock_count_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select using (business_id = current_business_id())', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('create policy %I on public.%I for insert with check (business_id = current_business_id())', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('create policy %I on public.%I for update using (business_id = current_business_id()) with check (business_id = current_business_id())', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('create policy %I on public.%I for delete using (business_id = current_business_id())', t || '_delete_own', t);
  end loop;
  -- the kardex and cost history are read-only for everyone: only the triggers write to them
  foreach t in array array['stock_movements','product_cost_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select using (business_id = current_business_id())', t || '_select_own', t);
  end loop;
end $$;
