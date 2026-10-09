-- Dogo POS — plan catalog: prices, limits and feature lists editable from the Admin Console.
-- Safe to re-run. Run AFTER 20260930_subscription_enforcement.sql (this file redefines
-- plan_limits() so the database limits come from the catalog instead of being hardcoded).
--
-- NOTE: "max_tellers" counts staff on top of the owner/admin. Team size allowed =
-- max_tellers + 1 (the owner). NULL means unlimited. Core is seeded with 1 teller.
-- Existing businesses that already have more staff than their plan allows are NOT
-- removed; the limit only blocks adding more.

create table if not exists public.plan_catalog (
  plan          text primary key check (plan in ('Free','Core','Core Group','Control','Control Group')),
  sort          int  not null default 0,
  display_name  text not null,
  tagline       text,
  monthly_price numeric not null default 0 check (monthly_price >= 0),
  yearly_price  numeric not null default 0 check (yearly_price >= 0),
  max_tellers   int check (max_tellers is null or max_tellers >= 0),
  max_branches  int check (max_branches is null or max_branches >= 1),
  max_products  int check (max_products is null or max_products >= 1),
  flags         jsonb  not null default '{}'::jsonb,
  features      text[] not null default '{}',
  updated_at    timestamptz not null default now()
);

alter table public.plan_catalog enable row level security;

-- Prices and features are public (they are shown on the landing page), so everyone,
-- including signed-out visitors, can read them. Only the platform super admin can change them.
drop policy if exists "plan_catalog_public_read" on public.plan_catalog;
create policy "plan_catalog_public_read" on public.plan_catalog
  for select to anon, authenticated using (true);

drop policy if exists "plan_catalog_super_admin_write" on public.plan_catalog;
create policy "plan_catalog_super_admin_write" on public.plan_catalog
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'allanotiende1998@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'allanotiende1998@gmail.com');

grant select on public.plan_catalog to anon, authenticated;
grant insert, update, delete on public.plan_catalog to authenticated;

-- Seed with the values the app already uses today (except Core = 1 teller, as requested).
insert into public.plan_catalog (plan, sort, display_name, tagline, monthly_price, yearly_price, max_tellers, max_branches, max_products, flags, features) values
('Free', 1, 'Free', 'For small kiosks and single tellers getting started.', 0, 0, 0, 1, 5,
  '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":false,"shifts":false,"restaurantKitchen":false,"profitReports":false,"teamAccounts":false,"etims":false,"advancedStockAlerts":false,"multiBranch":false,"prioritySupport":false}',
  array['1 branch & 1 user','Up to 5 catalog products','Cash sales & basic receipts','Camera barcode scanner','Offline sales storage']),
('Core', 2, 'Core POS', 'For active retail shops and restaurants needing control.', 999, 9999, 1, 1, null,
  '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":true,"shifts":true,"restaurantKitchen":true,"profitReports":true,"teamAccounts":true,"etims":false,"advancedStockAlerts":true,"multiBranch":false,"prioritySupport":false}',
  array['**Unlimited products**','M-Pesa STK Push integration','Shift & float reconciliation','Restaurant tables & kitchen tickets','Profit & cost reporting','1 teller account']),
('Core Group', 3, 'Core Group', 'Core POS for up to five branches under one business account.', 3999, 39999, 24, 5, null,
  '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":true,"shifts":true,"restaurantKitchen":true,"profitReports":true,"teamAccounts":true,"etims":false,"advancedStockAlerts":true,"multiBranch":true,"prioritySupport":false}',
  array['Everything in Core POS','**Up to 5 branches**','Staff accounts (up to 25)','Central sales overview','Shared owner billing']),
('Control', 4, 'Control POS', 'For growing supermarkets and tax-compliant merchants.', 1999, 19999, null, 1, null,
  '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":true,"shifts":true,"restaurantKitchen":true,"profitReports":true,"teamAccounts":true,"etims":true,"advancedStockAlerts":true,"multiBranch":true,"prioritySupport":true}',
  array['Everything in Core POS','**KRA eTIMS tax fiscalization**','Advanced reorder stock alerts','Multi-branch dashboard visibility','Priority 24/7 WhatsApp support']),
('Control Group', 5, 'Control Group', 'Control POS and advanced management for up to five branches.', 7999, 79999, null, 5, null,
  '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":true,"shifts":true,"restaurantKitchen":true,"profitReports":true,"teamAccounts":true,"etims":true,"advancedStockAlerts":true,"multiBranch":true,"prioritySupport":true}',
  array['Everything in Control POS','**Up to 5 branches**','KRA eTIMS support','Multi-store stock transfers','VIP 24/7 dedicated support'])
on conflict (plan) do nothing;

-- The database limits now come from the catalog (same signature as before, so the
-- existing triggers keep working). Unknown plans fall back to the Free row.
create or replace function public.plan_limits(plan text, out max_users int, out max_branches int, out max_products int)
language plpgsql stable as $$
declare c public.plan_catalog%rowtype;
begin
  select * into c from public.plan_catalog where plan_catalog.plan = coalesce(nullif(plan_limits.plan, ''), 'Free');
  if not found then
    select * into c from public.plan_catalog where plan_catalog.plan = 'Free';
  end if;
  if not found then
    max_users := 1; max_branches := 1; max_products := 5; return;
  end if;
  max_users    := coalesce(c.max_tellers + 1, 999999);
  max_branches := coalesce(c.max_branches, 999999);
  max_products := coalesce(c.max_products, 999999);
end;
$$;

-- Keep updated_at honest.
create or replace function public.plan_catalog_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_plan_catalog_touch on public.plan_catalog;
create trigger trg_plan_catalog_touch before update on public.plan_catalog
  for each row execute function public.plan_catalog_touch();

-- The Admin Console's settings form also saves these fields, which the original
-- platform_settings table never had (the save would fail on unknown columns).
alter table public.platform_settings add column if not exists telegram_bot_username text;
alter table public.platform_settings add column if not exists ga_measurement_id text;
alter table public.platform_settings add column if not exists broadcast_active boolean default false;
alter table public.platform_settings add column if not exists broadcast_type text default 'info';
alter table public.platform_settings add column if not exists broadcast_title text;
alter table public.platform_settings add column if not exists broadcast_message text;
