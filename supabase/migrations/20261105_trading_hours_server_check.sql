-- APPLIED to the live database on 2026-11-05 (as migration "trading_hours_server_check_v2").
-- Server-side trading-hours enforcement inside process_sale. Tellers cannot record a sale outside
-- businesses.opening_time..closing_time (Africa/Nairobi) when businesses.hours_enabled is true.
-- Admins and the service role are exempt. Signature of process_sale is unchanged (nothing dropped).
-- process_sale_offline: used by the offline sync; passes the time the sale was really made (honoured only if
-- >2 min and <72 h old) via a transaction-local setting, so a sale made in hours still syncs after closing.
-- Requires 20261105_business_trading_hours.sql (hours columns) first.

create or replace function public.process_sale(
  p_business_id uuid, p_cashier_id uuid, p_receipt_no text, p_customer_id uuid,
  p_subtotal_excl_vat numeric, p_vat_total numeric, p_total numeric, p_offline_uuid text, p_items jsonb,
  p_payment_method text default 'cash'::text, p_shift_id uuid default null::uuid, p_mpesa_receipt_no text default null::text
) returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_sale_id uuid; v_item jsonb; v_qty int; v_current_stock int; v_product_id uuid;
  v_safe_shift_id uuid; v_safe_customer_id uuid;
  v_uid uuid := auth.uid();
  v_is_service boolean := coalesce(auth.role() = 'service_role', false);
  v_h record; v_when timestamptz; v_sold timestamptz; v_t time; v_open time; v_close time; v_ok boolean;
begin
  if not v_is_service then
    if v_uid is null then
      raise exception 'Not authenticated' using errcode = '28000';
    end if;
    if p_business_id is distinct from public.current_business_id() then
      raise exception 'You cannot record sales for another business' using errcode = '42501';
    end if;
    if p_cashier_id is not null and p_cashier_id <> v_uid
       and not exists (select 1 from public.profiles where id = p_cashier_id and business_id = p_business_id) then
      raise exception 'Cashier does not belong to this business' using errcode = '42501';
    end if;
  end if;

  if p_offline_uuid is not null then
    select id into v_sale_id from public.sales where offline_uuid = p_offline_uuid and business_id = p_business_id;
    if v_sale_id is not null then return v_sale_id; end if;
  end if;

  -- Trading hours (tellers only; admins and service role exempt)
  if not v_is_service and not exists (select 1 from public.profiles where id = v_uid and role = 'admin') then
    select hours_enabled, opening_time, closing_time into v_h from public.businesses where id = p_business_id;
    if found and v_h.hours_enabled then
      v_when := now();
      begin
        v_sold := nullif(current_setting('app.sold_at', true), '')::timestamptz;
      exception when others then v_sold := null;
      end;
      if v_sold is not null and v_sold < now() - interval '2 minutes' and v_sold > now() - interval '72 hours' then
        v_when := v_sold;
      end if;
      v_t := (v_when at time zone 'Africa/Nairobi')::time;
      v_open := v_h.opening_time::time; v_close := v_h.closing_time::time;
      v_ok := case when v_open < v_close then (v_t >= v_open and v_t < v_close)
                   when v_open > v_close then (v_t >= v_open or v_t < v_close)
                   else true end;
      if not v_ok then
        raise exception 'Sales are closed. Trading hours are % to %.', v_h.opening_time, v_h.closing_time;
      end if;
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

  insert into public.sales (
    business_id, cashier_id, customer_id, receipt_no, subtotal_excl_vat, vat_total, total,
    offline_uuid, payment_method, shift_id, mpesa_receipt_no
  ) values (
    p_business_id, p_cashier_id, v_safe_customer_id, p_receipt_no, p_subtotal_excl_vat, p_vat_total, p_total,
    p_offline_uuid, coalesce(p_payment_method, 'cash'), v_safe_shift_id, p_mpesa_receipt_no
  ) returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'qty')::int;
    v_product_id := nullif(v_item->>'product_id', '')::uuid;
    if v_product_id is not null
       and not exists (select 1 from public.products where id = v_product_id and business_id = p_business_id) then
      v_product_id := null;
    end if;

    insert into public.sale_items (sale_id, product_id, code, name, qty, price, vat_rate, line_total, unit)
    values (v_sale_id, v_product_id, v_item->>'code', v_item->>'name', v_qty,
            (v_item->>'price')::numeric, (v_item->>'vat_rate')::numeric, (v_item->>'line_total')::numeric,
            coalesce(v_item->>'unit', 'piece'));

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
          jsonb_build_object('receipt_no', p_receipt_no, 'total', p_total, 'payment_method', p_payment_method));

  return v_sale_id;
end;
$function$;

create or replace function public.process_sale_offline(
  p_business_id uuid, p_cashier_id uuid, p_receipt_no text, p_customer_id uuid,
  p_subtotal_excl_vat numeric, p_vat_total numeric, p_total numeric, p_offline_uuid text, p_items jsonb,
  p_payment_method text default 'cash'::text, p_shift_id uuid default null::uuid, p_mpesa_receipt_no text default null::text,
  p_sold_at timestamptz default null
) returns uuid
language plpgsql security invoker set search_path to 'public'
as $function$
begin
  perform set_config('app.sold_at', coalesce(p_sold_at::text, ''), true);
  return public.process_sale(p_business_id, p_cashier_id, p_receipt_no, p_customer_id, p_subtotal_excl_vat,
    p_vat_total, p_total, p_offline_uuid, p_items, p_payment_method, p_shift_id, p_mpesa_receipt_no);
end;
$function$;

revoke all on function public.process_sale_offline(uuid,uuid,text,uuid,numeric,numeric,numeric,text,jsonb,text,uuid,text,timestamptz) from public, anon;
grant execute on function public.process_sale_offline(uuid,uuid,text,uuid,numeric,numeric,numeric,text,jsonb,text,uuid,text,timestamptz) to authenticated, service_role;
