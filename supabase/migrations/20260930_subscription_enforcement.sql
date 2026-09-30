-- Dogo POS — subscription plans: make them real and enforced server-side
-- Run this once in the Supabase SQL editor after 20260929_branches_and_manager_role.sql.
-- Safe to re-run: every statement is guarded.
--
-- WHY: the app currently decides which plan a business is on almost entirely from
-- localStorage ('dogo_biz_plans'), which any user can edit in their browser console
-- to grant themselves any plan for free. The "manual M-Pesa code" box on the upgrade
-- screen also accepted any 6+ character string as proof of payment and upgraded
-- instantly, with no verification at all. This migration adds real columns and
-- triggers so a plan can only change through this database, and a business cannot
-- exceed its plan's limits no matter what the browser sends.

-- 1. Subscription state lives on the business row, not in a browser.
alter table public.businesses add column if not exists subscription_status text not null default 'free';
alter table public.businesses add column if not exists subscription_renews_at timestamptz;
alter table public.businesses add column if not exists subscription_started_at timestamptz;
-- subscription_plan already exists and is already read as the fallback source in the app.

-- 2. Manual "I've paid" M-Pesa-code claims. Submitting one no longer changes anything
--    by itself — it just queues a claim for the platform admin to check against the
--    real M-Pesa statement and approve or reject.
create table if not exists public.subscription_claims (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  submitted_by uuid references auth.users(id),
  plan text not null,
  branches int not null default 1,
  billing text not null default 'monthly',
  amount numeric,
  phone text,
  mpesa_code text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewer_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.subscription_claims enable row level security;

drop policy if exists "claims_business_insert_own" on public.subscription_claims;
create policy "claims_business_insert_own" on public.subscription_claims
  for insert with check (business_id = current_business_id());

drop policy if exists "claims_business_select_own" on public.subscription_claims;
create policy "claims_business_select_own" on public.subscription_claims
  for select using (business_id = current_business_id());

-- Only the platform super admin account can approve/reject a claim. Matches the
-- email already hardcoded as PLATFORM_SUPER_ADMIN_EMAIL in index.html — change
-- both places together if that account ever changes.
drop policy if exists "claims_super_admin_update" on public.subscription_claims;
create policy "claims_super_admin_update" on public.subscription_claims
  for update using ((auth.jwt() ->> 'email') = 'allanotiende1998@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'allanotiende1998@gmail.com');

drop policy if exists "claims_super_admin_select_all" on public.subscription_claims;
create policy "claims_super_admin_select_all" on public.subscription_claims
  for select using ((auth.jwt() ->> 'email') = 'allanotiende1998@gmail.com');

-- Approving a claim (status -> 'approved') actually upgrades the business, in the
-- same transaction, so "approved" and "on the plan" can never drift apart.
create or replace function public.apply_subscription_claim() returns trigger
language plpgsql security definer as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    update public.businesses
      set subscription_plan = new.plan,
          subscription_status = 'active',
          subscription_started_at = coalesce(subscription_started_at, now()),
          subscription_renews_at = now() + (case when new.billing = 'yearly' then interval '365 days' else interval '30 days' end)
      where id = new.business_id;
    new.reviewed_at = now();
  elsif new.status = 'rejected' and old.status is distinct from 'rejected' then
    new.reviewed_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_apply_subscription_claim on public.subscription_claims;
create trigger trg_apply_subscription_claim
  before update on public.subscription_claims
  for each row execute function public.apply_subscription_claim();

-- 3. The actual lock: a business cannot exceed its own plan's limits, checked here —
--    not in the browser — so no client-side change can ever bypass it.
create or replace function public.plan_limits(plan text, out max_users int, out max_branches int, out max_products int)
language sql immutable as $$
  select case plan
      when 'Control Group' then 999999
      when 'Control'       then 999999
      when 'Core Group'    then 25
      when 'Core'          then 5
      else 1 -- Free
    end,
    case plan
      when 'Control Group' then 5
      when 'Core Group'    then 5
      else 1 -- Free, Core, Control
    end,
    case plan
      when 'Free' then 5
      else 999999
    end;
$$;

create or replace function public.enforce_team_limit() returns trigger
language plpgsql as $$
declare
  lim record; biz_plan text; current_count int;
begin
  if new.business_id is null then return new; end if;
  select subscription_plan into biz_plan from public.businesses where id = new.business_id;
  select * into lim from public.plan_limits(coalesce(biz_plan, 'Free'));
  select count(*) into current_count from public.profiles where business_id = new.business_id;
  if current_count >= lim.max_users then
    raise exception 'Team size limit reached for the % plan (max % member(s)). Upgrade to add more.', coalesce(biz_plan, 'Free'), lim.max_users;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_team_limit on public.profiles;
create trigger trg_enforce_team_limit
  before insert on public.profiles
  for each row execute function public.enforce_team_limit();

create or replace function public.enforce_branch_limit() returns trigger
language plpgsql as $$
declare
  lim record; biz_plan text; current_count int;
begin
  select subscription_plan into biz_plan from public.businesses where id = new.business_id;
  select * into lim from public.plan_limits(coalesce(biz_plan, 'Free'));
  select count(*) into current_count from public.branches where business_id = new.business_id;
  if current_count >= lim.max_branches then
    raise exception 'Branch limit reached for the % plan (max %). Upgrade to Core Group or Control Group for up to 5 branches.', coalesce(biz_plan, 'Free'), lim.max_branches;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_branch_limit on public.branches;
create trigger trg_enforce_branch_limit
  before insert on public.branches
  for each row execute function public.enforce_branch_limit();

create or replace function public.enforce_product_limit() returns trigger
language plpgsql as $$
declare
  lim record; biz_plan text; current_count int;
begin
  select subscription_plan into biz_plan from public.businesses where id = new.business_id;
  select * into lim from public.plan_limits(coalesce(biz_plan, 'Free'));
  select count(*) into current_count from public.products where business_id = new.business_id;
  if current_count >= lim.max_products then
    raise exception 'Catalog limit reached for the % plan (max % products). Upgrade to Core or above for unlimited products.', coalesce(biz_plan, 'Free'), lim.max_products;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_product_limit on public.products;
create trigger trg_enforce_product_limit
  before insert on public.products
  for each row execute function public.enforce_product_limit();

-- Platform super admin bypasses every limit above (e.g. testing another business):
-- the triggers check the target business's own plan, not the caller's, so this is
-- already safe — a platform admin switched into a Free-plan business still respects
-- that business's real limit, which is correct.

-- 4. Platform payout settings (where subscription money should go, and the alert/pricing
--    config) — was localStorage-only in the Admin Console, meaning it only existed on
--    whichever single browser/device last saved it, and had no real access control.
--    One row. Only the platform super admin can read or write it.
create table if not exists public.platform_settings (
  id boolean primary key default true check (id),  -- forces exactly one row
  mpesa_mode text default 'till',
  mpesa_till text,
  mpesa_paybill text,
  mpesa_account_name text,
  mpesa_phone text,
  daraja_env text default 'sandbox',
  daraja_consumer_key text,
  daraja_consumer_secret text,
  daraja_passkey text,
  bank_name text,
  bank_account_name text,
  bank_account_number text,
  paystack_public_key text,
  paystack_secret_key text,
  telegram_bot_token text,
  alert_whatsapp text,
  alert_telegram text,
  price_core numeric default 999,
  price_control numeric default 1999,
  updated_at timestamptz not null default now()
);

alter table public.platform_settings enable row level security;

drop policy if exists "platform_settings_super_admin_only" on public.platform_settings;
create policy "platform_settings_super_admin_only" on public.platform_settings
  for all using ((auth.jwt() ->> 'email') = 'allanotiende1998@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'allanotiende1998@gmail.com');

-- Every OTHER signed-in user needs to read the non-secret display fields only (which
-- till/paybill/phone to pay a subscription to) — never the Daraja/Paystack secrets.
-- A view is how we hand out "some columns" under RLS: policies apply per-row, not
-- per-column, so the sensitive columns simply aren't selected into this view at all.
create or replace view public.platform_payment_destination as
  select mpesa_mode, mpesa_till, mpesa_paybill, mpesa_account_name, mpesa_phone,
         price_core, price_control
  from public.platform_settings where id = true;

grant select on public.platform_payment_destination to authenticated;

insert into public.platform_settings (id) values (true) on conflict (id) do nothing;
