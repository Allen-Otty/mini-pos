
-- Pharmacy-ready features (dev first): generic name, dosage note, expired-stock block, expiry alerts.
-- Also fixes process_sale for items that are not in the catalogue (record variable was unassigned).

alter table public.products   add column if not exists generic_name text;
alter table public.sale_items add column if not exists dosage_note  text;
create index if not exists products_generic_name_idx on public.products (business_id, lower(generic_name));

-- 1. Lots: never sell from an expired lot; block the sale if only expired stock would cover it.
create or replace function public.trg_sale_items_stock()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_track boolean; v_left numeric; r record; v_take numeric; v_expired numeric;
begin
  if new.product_id is null then return new; end if;
  update public.stock_movements
     set type = 'sale', ref_type = 'sale', ref_id = new.sale_id::text, note = null
   where txid = txid_current() and product_id = new.product_id and type = 'adjustment' and ref_id is null;
  perform set_config('app.stock_reason', 'sale', true);
  perform set_config('app.stock_ref', new.sale_id::text, true);

  select track_lots into v_track from public.products where id = new.product_id;
  if coalesce(v_track, false) then
    v_left := coalesce(new.qty, 0);
    for r in select id, qty_remaining from public.product_lots
              where product_id = new.product_id and qty_remaining > 0
                and (expiry_date is null or expiry_date >= current_date)
              order by expiry_date nulls last, received_at, id
              for update loop
      exit when v_left <= 0;
      v_take := least(r.qty_remaining, v_left);
      update public.product_lots set qty_remaining = qty_remaining - v_take where id = r.id;
      v_left := v_left - v_take;
    end loop;
    if v_left > 0 then
      select coalesce(sum(qty_remaining), 0) into v_expired from public.product_lots
       where product_id = new.product_id and qty_remaining > 0 and expiry_date < current_date;
      if v_expired > 0 then
        raise exception 'EXPIRED_STOCK: % has only expired stock left (% units). Remove it from stock before selling.',
          coalesce(new.name, 'item'), v_expired using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end $function$;

-- 2. Expiry alerts for the caller's business (expired + expiring within p_days).
create or replace function public.expiry_alerts(p_days integer default 60)
returns table (product_id uuid, name text, generic_name text, lot_no text, expiry_date date,
               qty_remaining numeric, days_left integer, status text)
language sql stable security definer set search_path to 'public' as $$
  select p.id, p.name, p.generic_name, l.lot_no, l.expiry_date, l.qty_remaining,
         (l.expiry_date - current_date)::int,
         case when l.expiry_date < current_date then 'expired' else 'expiring' end
    from public.product_lots l join public.products p on p.id = l.product_id
   where l.business_id = public.current_business_id()
     and l.qty_remaining > 0 and l.expiry_date is not null
     and l.expiry_date <= current_date + greatest(coalesce(p_days, 60), 0)
   order by l.expiry_date, p.name;
$$;
revoke all on function public.expiry_alerts(integer) from public, anon;
grant execute on function public.expiry_alerts(integer) to authenticated;

-- 3. process_sale: scalar catalogue lookup (fixes open items) + dosage note per line.
create or replace function public.process_sale(p_business_id uuid, p_cashier_id uuid, p_receipt_no text, p_customer_id uuid, p_subtotal_excl_vat numeric, p_vat_total numeric, p_total numeric, p_offline_uuid text, p_items jsonb, p_payment_method text default 'cash', p_shift_id uuid default null, p_mpesa_receipt_no text default null)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare
  v_sale_id uuid; v_item jsonb; v_qty numeric; v_current_stock numeric; v_product_id uuid;
  v_safe_shift_id uuid; v_safe_customer_id uuid;
  v_uid uuid := auth.uid();
  v_is_service boolean := coalesce(auth.role() = 'service_role', false);
  v_mgr boolean := false;
  v_method text := coalesce(p_payment_method, 'cash');
  v_prod_id uuid; v_prod_price numeric; v_price numeric; v_line numeric; v_sum numeric := 0; v_receipt text;
begin
  if not v_is_service then
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_business_id is distinct from public.current_business_id() then
      raise exception 'You cannot record sales for another business' using errcode = '42501';
    end if;
    v_mgr := coalesce(public.stock_is_manager(), false) or coalesce(public.is_platform_admin(), false);
    if p_cashier_id is not null and p_cashier_id <> v_uid then
      if not v_mgr then raise exception 'You can only record your own sales' using errcode = '42501'; end if;
      if not exists (select 1 from public.profiles where id = p_cashier_id and business_id = p_business_id) then
        raise exception 'Cashier does not belong to this business' using errcode = '42501';
      end if;
    end if;
  else
    v_mgr := true;
  end if;

  if p_offline_uuid is not null then
    select id into v_sale_id from public.sales where offline_uuid = p_offline_uuid and business_id = p_business_id;
    if v_sale_id is not null then return v_sale_id; end if;
  end if;

  if v_method not in ('cash', 'mpesa', 'kcb', 'paystack', 'airtel') then
    raise exception 'Unknown payment method %', v_method using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item' using errcode = '22023';
  end if;
  if p_total is null or p_total < 0 then raise exception 'Invalid sale total' using errcode = '22023'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty   := (v_item->>'qty')::numeric;
    v_price := (v_item->>'price')::numeric;
    v_line  := (v_item->>'line_total')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity must be more than zero' using errcode = '22023'; end if;
    if v_price is null or v_price < 0 or v_line is null or v_line < 0 then
      raise exception 'Invalid price on item %', coalesce(v_item->>'name', '?') using errcode = '22023';
    end if;
    if abs(v_line - round(v_qty * v_price, 2)) > 0.02 then
      raise exception 'Line total does not match quantity x price for %', coalesce(v_item->>'name', '?') using errcode = '22023';
    end if;
    v_sum := v_sum + v_line;

    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    v_prod_id := null; v_prod_price := null;
    if v_product_id is not null then
      select id, price into v_prod_id, v_prod_price from public.products where id = v_product_id and business_id = p_business_id;
    end if;
    if v_prod_id is null then
      if not v_mgr then
        raise exception 'Only an admin or manager can sell items that are not in the catalog (%)', coalesce(v_item->>'name', '?') using errcode = '42501';
      end if;
    elsif not v_mgr and abs(v_price - v_prod_price) > 0.005 then
      raise exception 'Price for % does not match the catalog (catalog %, sent %)', coalesce(v_item->>'name', '?'), v_prod_price, v_price using errcode = '42501';
    end if;
  end loop;

  if abs(v_sum - p_total) > 0.05 then raise exception 'Sale total does not match the items' using errcode = '22023'; end if;
  if abs(coalesce(p_subtotal_excl_vat, 0) + coalesce(p_vat_total, 0) - p_total) > 0.10 then
    raise exception 'Subtotal and VAT do not add up to the total' using errcode = '22023';
  end if;

  v_receipt := case when v_method = 'cash' then null else p_mpesa_receipt_no end;
  if v_method = 'mpesa' and not v_is_service then
    if v_receipt is null or not exists (
         select 1 from public.payment_requests pr
          where pr.business_id = p_business_id and pr.mpesa_receipt = v_receipt
            and pr.status = 'success' and abs(pr.amount - p_total) <= 1) then
      raise exception 'M-Pesa payment is not confirmed for this receipt' using errcode = '42501';
    end if;
    if exists (select 1 from public.sales where business_id = p_business_id and mpesa_receipt_no = v_receipt) then
      raise exception 'This M-Pesa receipt was already used for another sale' using errcode = '23505';
    end if;
  end if;

  v_safe_shift_id := null;
  if p_shift_id is not null then
    select id into v_safe_shift_id from public.shift_sessions where id = p_shift_id and business_id = p_business_id;
  end if;
  v_safe_customer_id := null;
  if p_customer_id is not null then
    select id into v_safe_customer_id from public.customers where id = p_customer_id and business_id = p_business_id;
  end if;

  insert into public.sales (business_id, cashier_id, customer_id, receipt_no, subtotal_excl_vat, vat_total, total,
    offline_uuid, payment_method, shift_id, mpesa_receipt_no)
  values (p_business_id, p_cashier_id, v_safe_customer_id, p_receipt_no, p_subtotal_excl_vat, p_vat_total, p_total,
    p_offline_uuid, v_method, v_safe_shift_id, v_receipt)
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'qty')::numeric;
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    if v_product_id is not null
       and not exists (select 1 from public.products where id = v_product_id and business_id = p_business_id) then
      v_product_id := null;
    end if;

    insert into public.sale_items (sale_id, product_id, code, name, qty, price, vat_rate, line_total, unit, dosage_note)
    values (v_sale_id, v_product_id, v_item->>'code', v_item->>'name', v_qty,
            (v_item->>'price')::numeric, (v_item->>'vat_rate')::numeric, (v_item->>'line_total')::numeric,
            coalesce(v_item->>'unit', 'piece'), left(nullif(btrim(coalesce(v_item->>'dosage_note', '')), ''), 300));

    if v_product_id is not null then
      select stock into v_current_stock from public.products
        where id = v_product_id and business_id = p_business_id for update;
      if v_current_stock is not null then
        if v_current_stock < v_qty then
          raise exception 'Insufficient stock for product % (have %, need %)', v_item->>'name', v_current_stock, v_qty;
        end if;
        update public.products set stock = stock - v_qty where id = v_product_id and business_id = p_business_id;
      end if;
    end if;
  end loop;

  insert into public.audit_log (business_id, actor_id, actor_role, action, target_table, target_id, details)
  values (p_business_id, p_cashier_id, null, 'sale.created', 'sales', v_sale_id::text,
          jsonb_build_object('receipt_no', p_receipt_no, 'total', p_total, 'payment_method', v_method));
  return v_sale_id;
end;
$function$;
