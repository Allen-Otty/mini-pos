-- Dogo POS — customer invoices (credit sales, quotes-to-invoice, part payments).
-- New tables only: nothing here changes sales, stock, products or any existing function, so it is safe to run
-- on a live project. Until it is run, invoices.html shows a "run the migration" notice and nothing else changes.
-- Assumes the same helpers the other migrations use: current_business_id(), is_admin(), a customers table.

create table if not exists public.customer_invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  invoice_no text not null,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null,
  customer_phone text,
  customer_email text,
  customer_pin text,
  issue_date date not null default current_date,
  due_date date,
  status text not null default 'sent' check (status in ('draft','sent','partial','paid','void')),
  subtotal_excl_vat numeric(14,2) not null default 0,
  vat_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  amount_paid numeric(14,2) not null default 0,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (business_id, invoice_no)
);
create index if not exists idx_customer_invoices_business on public.customer_invoices (business_id, issue_date desc);

create table if not exists public.customer_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.customer_invoices(id) on delete cascade,
  business_id uuid not null,
  line_no int not null default 1,
  product_id uuid,
  description text not null,
  qty numeric(14,3) not null default 1 check (qty > 0),
  unit_price_excl_vat numeric(14,2) not null default 0 check (unit_price_excl_vat >= 0),
  vat_rate numeric(5,2) not null default 0,
  line_total numeric(14,2) not null default 0
);
create index if not exists idx_customer_invoice_items_invoice on public.customer_invoice_items (invoice_id);

create table if not exists public.customer_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.customer_invoices(id) on delete cascade,
  business_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  method text not null default 'cash',
  reference text,
  paid_on date not null default current_date,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists idx_customer_invoice_payments_invoice on public.customer_invoice_payments (invoice_id);

-- Invoice numbers: INV-0001, INV-0002 ... per business, assigned by the database so two devices never clash.
create or replace function public.assign_invoice_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('invoice:' || new.business_id::text, 0));
  if new.invoice_no is null or new.invoice_no = '' or exists (
       select 1 from public.customer_invoices i where i.business_id = new.business_id and i.invoice_no = new.invoice_no) then
    select coalesce(max(regexp_replace(invoice_no, '\D', '', 'g')::bigint), 0) + 1 into n
      from public.customer_invoices where business_id = new.business_id and invoice_no ~ '^INV-[0-9]+$';
    new.invoice_no := 'INV-' || lpad(n::text, 4, '0');
  end if;
  return new;
end $$;
revoke all on function public.assign_invoice_no() from public, anon, authenticated;
drop trigger if exists trg_assign_invoice_no on public.customer_invoices;
create trigger trg_assign_invoice_no before insert on public.customer_invoices
  for each row execute function public.assign_invoice_no();

-- Paying keeps the invoice's amount_paid and status in step, and refuses to overpay.
create or replace function public.apply_invoice_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv public.customer_invoices; paid numeric(14,2);
begin
  select * into inv from public.customer_invoices where id = coalesce(new.invoice_id, old.invoice_id) for update;
  if inv.id is null then return coalesce(new, old); end if;
  select coalesce(sum(amount), 0) into paid from public.customer_invoice_payments where invoice_id = inv.id;
  if paid > inv.total + 0.005 then raise exception 'Payment is more than the amount still owed on % (total %, paid %)', inv.invoice_no, inv.total, paid; end if;
  update public.customer_invoices
     set amount_paid = paid,
         status = case when status = 'void' then 'void'
                       when paid >= total - 0.005 and total > 0 then 'paid'
                       when paid > 0 then 'partial'
                       when status in ('paid','partial') then 'sent' else status end
   where id = inv.id;
  return coalesce(new, old);
end $$;
revoke all on function public.apply_invoice_payment() from public, anon, authenticated;
drop trigger if exists trg_apply_invoice_payment on public.customer_invoice_payments;
create trigger trg_apply_invoice_payment after insert or delete on public.customer_invoice_payments
  for each row execute function public.apply_invoice_payment();

-- Row level security: each business sees only its own invoices.
do $$
declare t text;
begin
  foreach t in array array['customer_invoices','customer_invoice_items','customer_invoice_payments'] loop
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
end $$;
grant select, insert, update, delete on public.customer_invoices, public.customer_invoice_items, public.customer_invoice_payments to authenticated;
