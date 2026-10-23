-- Dogo POS — full invoicing: quotes, credit notes, eTIMS queue, customer self-service link, stock on delivery.
-- Run AFTER 20261021_customer_invoices.sql. New columns/tables/functions only; nothing existing is removed.
-- Safe to re-run.
--
-- IMPORTANT (eTIMS): this prepares every invoice and credit note for KRA eTIMS and queues it, exactly like sales
-- do today (status 'pending_credentials'). Actual signing needs your KRA OSCU/VSCU device credentials and a signing
-- service that calls public.record_etims_result(); until then invoices show "eTIMS pending", never "signed".

-- ---------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------
alter table public.customer_invoices
  add column if not exists doc_type text not null default 'invoice',
  add column if not exists ref_invoice_id uuid references public.customer_invoices(id) on delete set null,
  add column if not exists converted_from_id uuid references public.customer_invoices(id) on delete set null,
  add column if not exists credited_total numeric(14,2) not null default 0,
  add column if not exists share_token text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  add column if not exists delivered_at timestamptz,
  add column if not exists etims_status text not null default 'not_submitted',
  add column if not exists etims_invc_no text,
  add column if not exists etims_qr_code text,
  add column if not exists etims_cfm_dt text,
  add column if not exists etims_submitted_at timestamptz;
create unique index if not exists uq_customer_invoices_share_token on public.customer_invoices (share_token);
create index if not exists idx_customer_invoices_ref on public.customer_invoices (ref_invoice_id);

alter table public.customer_invoice_items add column if not exists tax_code text;   -- KRA class: A exempt, B 16%, C zero-rated, D non-VAT, E 8%

do $$ begin
  alter table public.customer_invoices add constraint customer_invoices_doc_type_check check (doc_type in ('quote','invoice','credit_note'));
exception when duplicate_object then null; end $$;

alter table public.customer_invoices drop constraint if exists customer_invoices_status_check;
alter table public.customer_invoices add constraint customer_invoices_status_check
  check (status in ('draft','sent','partial','paid','void','accepted','declined','converted','credited'));

-- ---------------------------------------------------------------------------------------------
-- 2. Numbering: INV-0001, QT-0001, CN-0001 per business
-- ---------------------------------------------------------------------------------------------
create or replace function public.assign_invoice_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare n bigint; pfx text;
begin
  perform pg_advisory_xact_lock(hashtextextended('invoice:' || new.business_id::text, 0));
  pfx := case new.doc_type when 'quote' then 'QT' when 'credit_note' then 'CN' else 'INV' end;
  if new.invoice_no is null or new.invoice_no = '' or exists (
       select 1 from public.customer_invoices i where i.business_id = new.business_id and i.invoice_no = new.invoice_no) then
    select coalesce(max(regexp_replace(invoice_no, '\D', '', 'g')::bigint), 0) + 1 into n
      from public.customer_invoices where business_id = new.business_id and invoice_no ~ ('^' || pfx || '-[0-9]+$');
    new.invoice_no := pfx || '-' || lpad(n::text, 4, '0');
  end if;
  return new;
end $$;
revoke all on function public.assign_invoice_no() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Balance = total - credit notes - payments. One function keeps status right for payments and credit notes.
-- ---------------------------------------------------------------------------------------------
create or replace function public.recompute_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare inv public.customer_invoices; paid numeric(14,2); cred numeric(14,2); net numeric(14,2);
begin
  select * into inv from public.customer_invoices where id = p_id for update;
  if inv.id is null or inv.doc_type <> 'invoice' then return; end if;
  select coalesce(sum(amount), 0) into paid from public.customer_invoice_payments where invoice_id = p_id;
  select coalesce(sum(total), 0) into cred from public.customer_invoices where ref_invoice_id = p_id and doc_type = 'credit_note' and status <> 'void';
  if cred > inv.total + 0.005 then
    raise exception 'Credit notes (%) are more than the total of % (%)', cred, inv.invoice_no, inv.total;
  end if;
  net := inv.total - cred;
  if paid > net + 0.005 then
    raise exception 'Payment is more than the amount still owed on % (owed %, paid %)', inv.invoice_no, net, paid;
  end if;
  update public.customer_invoices
     set amount_paid = paid, credited_total = cred,
         status = case when status in ('void', 'draft') then status
                       when cred > 0 and net <= 0.005 then 'credited'
                       when net > 0.005 and paid >= net - 0.005 then 'paid'
                       when paid > 0 then 'partial'
                       else 'sent' end
   where id = p_id;
end $$;
revoke all on function public.recompute_invoice(uuid) from public, anon, authenticated;

create or replace function public.apply_invoice_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.recompute_invoice(coalesce(new.invoice_id, old.invoice_id));
  return coalesce(new, old);
end $$;
revoke all on function public.apply_invoice_payment() from public, anon, authenticated;

create or replace function public.apply_credit_note() returns trigger
language plpgsql security definer set search_path = public as $$
declare ref uuid;
begin
  ref := case when tg_op = 'DELETE' then old.ref_invoice_id else new.ref_invoice_id end;
  if ref is not null then perform public.recompute_invoice(ref); end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.apply_credit_note() from public, anon, authenticated;

drop trigger if exists trg_apply_credit_note_iu on public.customer_invoices;
create trigger trg_apply_credit_note_iu after insert or update on public.customer_invoices
  for each row when (new.doc_type = 'credit_note') execute function public.apply_credit_note();
drop trigger if exists trg_apply_credit_note_d on public.customer_invoices;
create trigger trg_apply_credit_note_d after delete on public.customer_invoices
  for each row when (old.doc_type = 'credit_note') execute function public.apply_credit_note();

-- ---------------------------------------------------------------------------------------------
-- 4. eTIMS queue (same pattern as sales: prepared payload, status pending_credentials until a signer runs)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.etims_invoice_submissions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  invoice_id uuid not null references public.customer_invoices(id) on delete cascade,
  payload jsonb not null,
  status text not null default 'pending_credentials',
  response jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_etims_invoice_submissions_invoice on public.etims_invoice_submissions (invoice_id);
alter table public.etims_invoice_submissions enable row level security;
drop policy if exists etims_invoice_submissions_select_own on public.etims_invoice_submissions;
create policy etims_invoice_submissions_select_own on public.etims_invoice_submissions for select using (business_id = current_business_id());
grant select on public.etims_invoice_submissions to authenticated;

create or replace function public.queue_invoice_etims(p_invoice_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare inv public.customer_invoices; orig public.customer_invoices; es record; payload jsonb; items jsonb; cnt int;
begin
  select * into inv from public.customer_invoices where id = p_invoice_id and business_id = current_business_id();
  if inv.id is null then raise exception 'Invoice not found'; end if;
  if inv.doc_type = 'quote' then raise exception 'Quotes are not sent to eTIMS. Convert the quote to an invoice first.'; end if;
  if inv.status in ('draft', 'void') then raise exception 'Only issued invoices can be sent to eTIMS.'; end if;
  if inv.etims_status = 'signed' then return 'signed'; end if;
  select kra_pin, bhf_id into es from public.etims_settings where business_id = inv.business_id;
  if inv.doc_type = 'credit_note' then select * into orig from public.customer_invoices where id = inv.ref_invoice_id; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'itemSeq', it.line_no, 'itemNm', it.description, 'qty', it.qty, 'prc', it.unit_price_excl_vat * (1 + it.vat_rate / 100),
           'taxTyCd', coalesce(it.tax_code, case when it.vat_rate >= 16 then 'B' when it.vat_rate >= 8 then 'E' else 'C' end),
           'taxAmt', round(it.line_total - it.line_total / (1 + it.vat_rate / 100), 2), 'totAmt', it.line_total) order by it.line_no), '[]'::jsonb),
         count(*)
    into items, cnt from public.customer_invoice_items it where it.invoice_id = inv.id;

  payload := jsonb_build_object(
    'tin', es.kra_pin, 'bhfId', coalesce(es.bhf_id, '00'), 'invcNo', inv.invoice_no,
    'orgInvcNo', case when inv.doc_type = 'credit_note' then coalesce(orig.etims_invc_no, orig.invoice_no) else null end,
    'custTin', inv.customer_pin, 'custNm', inv.customer_name,
    'salesTyCd', 'N', 'rcptTyCd', case when inv.doc_type = 'credit_note' then 'R' else 'S' end, 'pmtTyCd', '01', 'salesSttsCd', '02',
    'cfmDt', to_char(inv.created_at at time zone 'Africa/Nairobi', 'YYYYMMDDHH24MISS'),
    'totItemCnt', cnt, 'taxblAmt', inv.subtotal_excl_vat, 'taxAmt', inv.vat_total, 'totAmt', inv.total, 'itemList', items);

  insert into public.etims_invoice_submissions (business_id, invoice_id, payload, status) values (inv.business_id, inv.id, payload, 'pending_credentials');
  update public.customer_invoices set etims_status = 'pending_credentials', etims_submitted_at = now() where id = inv.id;
  return 'pending_credentials';
end $$;
revoke all on function public.queue_invoice_etims(uuid) from public, anon;
grant execute on function public.queue_invoice_etims(uuid) to authenticated;

-- Called by the signing service (service role only) once KRA returns the signed invoice.
create or replace function public.record_etims_result(p_invoice_id uuid, p_invc_no text, p_qr text, p_cfm_dt text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.customer_invoices set etims_status = 'signed', etims_invc_no = p_invc_no, etims_qr_code = p_qr, etims_cfm_dt = p_cfm_dt where id = p_invoice_id;
  update public.etims_invoice_submissions set status = 'signed' where invoice_id = p_invoice_id and status <> 'signed';
end $$;
revoke all on function public.record_etims_result(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_etims_result(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Quote -> invoice, credit notes, delivery (stock out)
-- ---------------------------------------------------------------------------------------------
create or replace function public.convert_quote_to_invoice(p_quote_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare q public.customer_invoices; new_id uuid;
begin
  select * into q from public.customer_invoices where id = p_quote_id and business_id = current_business_id() and doc_type = 'quote' for update;
  if q.id is null then raise exception 'Quote not found'; end if;
  if q.status in ('converted', 'declined') then raise exception 'This quote is already %.', q.status; end if;
  insert into public.customer_invoices (business_id, invoice_no, doc_type, customer_id, customer_name, customer_phone, customer_email, customer_pin,
      issue_date, due_date, status, subtotal_excl_vat, vat_total, total, notes, converted_from_id)
    values (q.business_id, '', 'invoice', q.customer_id, q.customer_name, q.customer_phone, q.customer_email, q.customer_pin,
      current_date, current_date + 14, 'sent', q.subtotal_excl_vat, q.vat_total, q.total, q.notes, q.id)
    returning id into new_id;
  insert into public.customer_invoice_items (invoice_id, business_id, line_no, product_id, description, qty, unit_price_excl_vat, vat_rate, line_total, tax_code)
    select new_id, business_id, line_no, product_id, description, qty, unit_price_excl_vat, vat_rate, line_total, tax_code
      from public.customer_invoice_items where invoice_id = q.id;
  update public.customer_invoices set status = 'converted' where id = q.id;
  return new_id;
end $$;
revoke all on function public.convert_quote_to_invoice(uuid) from public, anon;
grant execute on function public.convert_quote_to_invoice(uuid) to authenticated;

create or replace function public.create_credit_note(p_invoice_id uuid, p_reason text default null, p_amount numeric default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv public.customer_invoices; remaining numeric(14,2); amt numeric(14,2); vat numeric(14,2); sub numeric(14,2); new_id uuid;
begin
  select * into inv from public.customer_invoices where id = p_invoice_id and business_id = current_business_id() and doc_type = 'invoice' for update;
  if inv.id is null then raise exception 'Invoice not found'; end if;
  if inv.status in ('draft', 'void') then raise exception 'Only issued invoices can be credited.'; end if;
  remaining := inv.total - inv.credited_total;
  amt := round(coalesce(p_amount, remaining), 2);
  if amt <= 0 then raise exception 'Nothing left to credit on %.', inv.invoice_no; end if;
  if amt > remaining + 0.005 then raise exception 'A credit note cannot be more than what is left on % (%).', inv.invoice_no, remaining; end if;
  vat := case when inv.total > 0 then round(amt * inv.vat_total / inv.total, 2) else 0 end;
  sub := amt - vat;
  insert into public.customer_invoices (business_id, invoice_no, doc_type, ref_invoice_id, customer_id, customer_name, customer_phone, customer_email, customer_pin,
      issue_date, status, subtotal_excl_vat, vat_total, total, notes)
    values (inv.business_id, '', 'credit_note', inv.id, inv.customer_id, inv.customer_name, inv.customer_phone, inv.customer_email, inv.customer_pin,
      current_date, 'sent', sub, vat, amt, nullif(p_reason, ''))
    returning id into new_id;
  insert into public.customer_invoice_items (invoice_id, business_id, line_no, description, qty, unit_price_excl_vat, vat_rate, line_total)
    values (new_id, inv.business_id, 1, 'Credit against ' || inv.invoice_no || coalesce(': ' || nullif(p_reason, ''), ''), 1, sub,
            case when sub > 0 then round(vat / sub * 100, 2) else 0 end, amt);
  return new_id;
end $$;
revoke all on function public.create_credit_note(uuid, text, numeric) from public, anon;
grant execute on function public.create_credit_note(uuid, text, numeric) to authenticated;

-- Takes the invoiced products out of stock (once). Refuses if any item would go below zero.
create or replace function public.deliver_invoice(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare inv public.customer_invoices; it record; n int;
begin
  select * into inv from public.customer_invoices where id = p_invoice_id and business_id = current_business_id() and doc_type = 'invoice' for update;
  if inv.id is null then raise exception 'Invoice not found'; end if;
  if inv.status in ('draft', 'void', 'credited') then raise exception 'This invoice cannot be delivered.'; end if;
  if inv.delivered_at is not null then raise exception 'Stock for % was already taken out.', inv.invoice_no; end if;
  for it in select product_id, description, qty from public.customer_invoice_items where invoice_id = inv.id and product_id is not null loop
    update public.products set stock = stock - it.qty where id = it.product_id and business_id = inv.business_id and stock >= it.qty;
    get diagnostics n = row_count;
    if n = 0 then raise exception 'Not enough stock for %.', it.description; end if;
  end loop;
  update public.customer_invoices set delivered_at = now() where id = inv.id;
end $$;
revoke all on function public.deliver_invoice(uuid) from public, anon;
grant execute on function public.deliver_invoice(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. Customer self-service link: invoice.html?t=<share_token>. Anyone holding the long random token can view
--    that one document; nothing else about the business or other customers is reachable.
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_invoice_public(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare inv public.customer_invoices; biz record; items jsonb; orig_no text;
begin
  if p_token is null or length(p_token) < 40 then return null; end if;
  select * into inv from public.customer_invoices where share_token = p_token and status <> 'draft';
  if inv.id is null then return null; end if;
  select name, location, kra_pin, receipt_phone, logo_url, pochi_number into biz from public.businesses where id = inv.business_id;
  select coalesce(jsonb_agg(jsonb_build_object('description', description, 'qty', qty, 'unit_price_excl_vat', unit_price_excl_vat,
           'vat_rate', vat_rate, 'line_total', line_total) order by line_no), '[]'::jsonb) into items
    from public.customer_invoice_items where invoice_id = inv.id;
  if inv.ref_invoice_id is not null then select invoice_no into orig_no from public.customer_invoices where id = inv.ref_invoice_id; end if;
  return jsonb_build_object(
    'doc_type', inv.doc_type, 'invoice_no', inv.invoice_no, 'status', inv.status, 'issue_date', inv.issue_date, 'due_date', inv.due_date,
    'customer_name', inv.customer_name, 'customer_pin', inv.customer_pin, 'notes', inv.notes, 'against', orig_no,
    'subtotal_excl_vat', inv.subtotal_excl_vat, 'vat_total', inv.vat_total, 'total', inv.total, 'amount_paid', inv.amount_paid, 'credited_total', inv.credited_total,
    'etims_status', inv.etims_status, 'etims_invc_no', inv.etims_invc_no, 'etims_qr_code', inv.etims_qr_code,
    'business', jsonb_build_object('name', biz.name, 'location', biz.location, 'kra_pin', biz.kra_pin, 'phone', biz.receipt_phone, 'logo_url', biz.logo_url, 'till', biz.pochi_number),
    'items', items);
end $$;
revoke all on function public.get_invoice_public(text) from public;
grant execute on function public.get_invoice_public(text) to anon, authenticated;
