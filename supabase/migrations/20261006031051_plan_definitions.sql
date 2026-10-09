-- Copied from production (applied 2026-10-06) so the repo matches the live database.
-- plan_definitions is the source of truth for plan prices, limits and pricing-page bullets;
-- the Admin Console edits it and plan_limits() reads it.
create table if not exists public.plan_definitions (
  plan          text primary key check (plan in ('Free','Core','Control','Core Group','Control Group')),
  display_name  text not null,
  sort_order    int  not null,
  price_monthly numeric not null default 0 check (price_monthly >= 0),
  price_yearly  numeric not null default 0 check (price_yearly  >= 0),
  max_tellers   int check (max_tellers  is null or max_tellers  >= 0),
  max_branches  int check (max_branches is null or max_branches >= 1),
  max_products  int check (max_products is null or max_products >= 0),
  features      jsonb not null default '[]'::jsonb,
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);

alter table public.plan_definitions enable row level security;

drop policy if exists "plans_public_read" on public.plan_definitions;
create policy "plans_public_read" on public.plan_definitions for select to anon, authenticated using (true);

drop policy if exists "plans_platform_admin_write" on public.plan_definitions;
create policy "plans_platform_admin_write" on public.plan_definitions for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

grant select on public.plan_definitions to anon, authenticated;
grant insert, update, delete on public.plan_definitions to authenticated;

create or replace function public.plan_definitions_touch() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists plan_definitions_touch on public.plan_definitions;
create trigger plan_definitions_touch before update on public.plan_definitions
  for each row execute function public.plan_definitions_touch();

insert into public.plan_definitions (plan, display_name, sort_order, price_monthly, price_yearly, max_tellers, max_branches, max_products, features) values
 ('Free',          'Free (Starter)', 0,    0,     0, 0,    1,    5,    '["1 branch, owner login only","Up to 5 catalog products","Cash sales & basic receipts","Camera barcode scanner","Offline sale storage"]'),
 ('Core',          'Core POS',       1,  999,  9999, 2,    1,    null, '["Unlimited products","M-Pesa STK Push integration","Shift & float reconciliation","Restaurant tables & kitchen tickets","Profit & cost reporting","1 branch & 2 tellers"]'),
 ('Control',       'Control POS',    2, 1999, 19999, 5,    3,    null, '["Everything in Core POS","KRA eTIMS tax fiscalization","Advanced reorder stock alerts","3 branches & 5 tellers","Priority 24/7 WhatsApp support"]'),
 ('Core Group',    'Core Group',     3, 3999, 39999, null, 5,    null, '["Everything in Core POS","Up to 5 branches","Unlimited tellers","Central sales overview","Shared owner billing"]'),
 ('Control Group', 'Control Group',  4, 7999, 79999, null, null, null, '["Everything in Control POS","Unlimited branches & tellers","KRA eTIMS support","Multi-store stock transfers","VIP 24/7 dedicated support"]')
on conflict (plan) do nothing;

drop function if exists public.plan_limits(text);
create function public.plan_limits(p_plan text, out max_tellers int, out max_branches int, out max_products int)
language plpgsql stable security definer set search_path = public as $$
declare d public.plan_definitions;
begin
  select * into d from public.plan_definitions where plan = coalesce(p_plan, 'Free');
  if not found then select * into d from public.plan_definitions where plan = 'Free'; end if;
  if not found then max_tellers := 0; max_branches := 1; max_products := 5; return; end if;
  max_tellers  := coalesce(d.max_tellers, 999999);
  max_branches := coalesce(d.max_branches, 999999);
  max_products := coalesce(d.max_products, 999999);
end;
$$;

create or replace view public.platform_payment_destination as
  select s.mpesa_mode, s.mpesa_till, s.mpesa_paybill, s.mpesa_account_name, s.mpesa_phone,
         (select price_monthly from public.plan_definitions where plan = 'Core')          as price_core,
         (select price_monthly from public.plan_definitions where plan = 'Control')       as price_control,
         (select price_monthly from public.plan_definitions where plan = 'Core Group')    as price_core_group,
         (select price_monthly from public.plan_definitions where plan = 'Control Group') as price_control_group
  from public.platform_settings s where s.id = true;
