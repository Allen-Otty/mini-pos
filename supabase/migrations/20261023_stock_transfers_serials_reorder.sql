-- Dogo POS — branch stock transfers, serial numbers at the till, reorder suggestions.
-- Run AFTER 20261018_purchasing_inventory_control.sql (needs product_serials and stock_is_manager()).
-- Safe to re-run. Additive only: nothing existing is altered, and process_sale is untouched.
--
-- HOW BRANCH STOCK WORKS
-- products.stock stays the business-wide total (so the till, reports and kardex behave exactly as today).
-- branch_stock records how much of that total is held at each branch. Whatever is not allocated to a
-- branch is "Main store". A transfer moves quantity between Main store and branches (or branch to branch);
-- the business total does not change. The till still sells against the business total.

create table if not exists public.branch_stock (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  branch_id   uuid not null references public.branches(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  qty         numeric not null default 0 check (qty >= 0),
  updated_at  timestamptz not null default now(),
  unique (branch_id, product_id)
);
create index if not exists branch_stock_business_idx on public.branch_stock (business_id, product_id);

create table if not exists public.stock_transfers (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  from_branch_id uuid references public.branches(id) on delete set null,   -- null = Main store
  to_branch_id   uuid references public.branches(id) on delete set null,   -- null = Main store
  from_name      text not null,
  to_name        text not null,
  note           text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  check (from_name <> to_name)
);
create index if not exists stock_transfers_business_idx on public.stock_transfers (business_id, created_at desc);

create table if not exists public.stock_transfer_items (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  qty         numeric not null check (qty > 0)
);
create index if not exists stock_transfer_items_tr_idx on public.stock_transfer_items (transfer_id);

alter table public.branch_stock         enable row level security;
alter table public.stock_transfers      enable row level security;
alter table public.stock_transfer_items enable row level security;
drop policy if exists branch_stock_read on public.branch_stock;
create policy branch_stock_read on public.branch_stock for select using (business_id = current_business_id());
drop policy if exists stock_transfers_read on public.stock_transfers;
create policy stock_transfers_read on public.stock_transfers for select using (business_id = current_business_id());
drop policy if exists stock_transfer_items_read on public.stock_transfer_items;
create policy stock_transfer_items_read on public.stock_transfer_items for select using (business_id = current_business_id());
-- no insert/update/delete policies: quantities only move through transfer_stock()

-- p_items: [{product_id, qty}]   p_from / p_to: branch id, or null for Main store
create or replace function public.transfer_stock(p_from uuid, p_to uuid, p_items jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_biz uuid := current_business_id(); v_tid uuid; v_fname text; v_tname text;
  it jsonb; v_pid uuid; v_qty numeric; v_total numeric; v_alloc numeric; v_have numeric; v_pname text;
begin
  if v_biz is null or not public.stock_is_manager() then raise exception 'Only an admin or manager can move stock'; end if;
  if p_from is not distinct from p_to then raise exception 'Choose two different locations'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one item'; end if;

  if p_from is null then v_fname := 'Main store';
  else select name into v_fname from public.branches where id = p_from and business_id = v_biz;
       if v_fname is null then raise exception 'Source branch not found'; end if; end if;
  if p_to is null then v_tname := 'Main store';
  else select name into v_tname from public.branches where id = p_to and business_id = v_biz;
       if v_tname is null then raise exception 'Destination branch not found'; end if; end if;

  insert into public.stock_transfers (business_id, from_branch_id, to_branch_id, from_name, to_name, note)
  values (v_biz, p_from, p_to, v_fname, v_tname, nullif(trim(p_note), '')) returning id into v_tid;

  for it in select * from jsonb_array_elements(p_items) loop
    v_pid := (it->>'product_id')::uuid; v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity must be more than zero'; end if;
    select stock, name into v_total, v_pname from public.products where id = v_pid and business_id = v_biz for update;
    if v_pname is null then raise exception 'Product not found'; end if;
    select coalesce(sum(qty), 0) into v_alloc from public.branch_stock where product_id = v_pid;

    if p_from is null then v_have := greatest(0, v_total - v_alloc);
    else select coalesce(qty, 0) into v_have from public.branch_stock where branch_id = p_from and product_id = v_pid; v_have := coalesce(v_have, 0); end if;
    if v_qty > v_have then raise exception 'Not enough % at %: % available', v_pname, v_fname, v_have; end if;

    if p_from is not null then
      update public.branch_stock set qty = qty - v_qty, updated_at = now() where branch_id = p_from and product_id = v_pid;
    end if;
    if p_to is not null then
      insert into public.branch_stock (business_id, branch_id, product_id, qty) values (v_biz, p_to, v_pid, v_qty)
      on conflict (branch_id, product_id) do update set qty = public.branch_stock.qty + excluded.qty, updated_at = now();
    end if;
    insert into public.stock_transfer_items (transfer_id, business_id, product_id, qty) values (v_tid, v_biz, v_pid, v_qty);
  end loop;
  return v_tid;
end $$;
revoke all on function public.transfer_stock(uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.transfer_stock(uuid, uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Serial numbers at the till. Call after the sale is saved:
--   sell_serials(sale_id, [{product_id, serials:["SN1","SN2"]}])
-- Marks each serial sold and links it to the sale. All-or-nothing; fails if a serial is not in stock.
-- ---------------------------------------------------------------------------------------------
create or replace function public.sell_serials(p_sale_id uuid, p_items jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_biz uuid := current_business_id(); it jsonb; s text; v_n integer := 0; v_cnt integer;
begin
  if v_biz is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from public.sales where id = p_sale_id and business_id = v_biz) then raise exception 'Sale not found'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    for s in select jsonb_array_elements_text(it->'serials') loop
      update public.product_serials set status = 'sold', sale_id = p_sale_id
       where business_id = v_biz and product_id = (it->>'product_id')::uuid and serial_no = s and status = 'in_stock';
      get diagnostics v_cnt = row_count;
      if v_cnt = 0 then raise exception 'Serial % is not in stock for this product', s; end if;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end $$;
revoke all on function public.sell_serials(uuid, jsonb) from public, anon;
grant execute on function public.sell_serials(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Reorder suggestions from real sales. For each product: units sold in the last p_days, daily
-- velocity, days of cover left, and how many to order to cover p_cover_days (never less than
-- reaching the reorder level). Only products that are at/below their reorder level or will run out
-- within p_cover_days are returned.
-- ---------------------------------------------------------------------------------------------
create or replace function public.reorder_suggestions(p_days integer default 30, p_cover_days integer default 30)
returns table (product_id uuid, name text, unit text, stock numeric, reorder_level numeric, sold_qty numeric,
               daily_velocity numeric, days_left numeric, suggested_qty numeric, last_cost numeric)
language sql stable security definer set search_path = public as $$
  with sold as (
    select si.product_id, sum(si.qty) as q
      from public.sale_items si join public.sales s on s.id = si.sale_id
     where s.business_id = current_business_id() and s.created_at >= now() - make_interval(days => greatest(p_days, 1))
     group by si.product_id
  ), base as (
    select p.id, p.name, p.unit, p.stock, p.reorder_level, p.cost, coalesce(sold.q, 0) as sold_qty,
           coalesce(sold.q, 0) / greatest(p_days, 1)::numeric as vel
      from public.products p left join sold on sold.product_id = p.id
     where p.business_id = current_business_id() and not p.archived
  )
  select id, name, unit, stock, reorder_level, round(sold_qty, 3), round(vel, 3),
         case when vel > 0 then round(stock / vel, 1) end,
         ceil(greatest(vel * greatest(p_cover_days, 1) - stock, reorder_level * 2 - stock, 0)),
         cost
    from base
   where stock <= reorder_level or (vel > 0 and stock / vel <= greatest(p_cover_days, 1))
   order by (case when vel > 0 then stock / vel end) nulls last, name;
$$;
revoke all on function public.reorder_suggestions(integer, integer) from public, anon;
grant execute on function public.reorder_suggestions(integer, integer) to authenticated;
