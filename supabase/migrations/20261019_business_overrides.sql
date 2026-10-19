-- Dogo POS — per-business controls for the platform admin (Admin Console > Manage Business).
--   * extra_tellers / extra_branches / extra_products: added ON TOP of what the plan allows
--     (e.g. Core allows 2 tellers; extra_tellers = 3 lets that business have 5).
--   * feature_overrides: per-business on/off for plan feature flags, e.g. {"etims": true, "mpesaStk": false}.
--     A flag that is missing here follows the plan. The app applies these when it builds the plan info.
--   * business_admin_notes: private notes, visible to the platform admin only (kept out of the
--     businesses row, which every member of that business can read).
-- The limit triggers keep enforcing in the database, now with the extras included.
-- Business admins cannot edit any of these (guard trigger below). Safe to re-run.
-- Run AFTER 20261010_subscription_guard.sql (it replaces guard_business_subscription()).

alter table public.businesses add column if not exists extra_tellers  integer not null default 0 check (extra_tellers  >= 0 and extra_tellers  <= 100000);
alter table public.businesses add column if not exists extra_branches integer not null default 0 check (extra_branches >= 0 and extra_branches <= 100000);
alter table public.businesses add column if not exists extra_products integer not null default 0 check (extra_products >= 0 and extra_products <= 10000000);
alter table public.businesses add column if not exists feature_overrides jsonb not null default '{}'::jsonb;
do $$ begin
  alter table public.businesses add constraint businesses_feature_overrides_object check (jsonb_typeof(feature_overrides) = 'object');
exception when duplicate_object then null; end $$;

create table if not exists public.business_admin_notes (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  notes       text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
alter table public.business_admin_notes enable row level security;
drop policy if exists "admin_notes_platform_admin_all" on public.business_admin_notes;
create policy "admin_notes_platform_admin_all" on public.business_admin_notes for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
grant select, insert, update, delete on public.business_admin_notes to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Effective limits = plan limit + the business's extras. "Unlimited" (999999) stays unlimited.
-- ---------------------------------------------------------------------------------------------
create or replace function public.business_limits(p_business_id uuid, out max_tellers int, out max_branches int, out max_products int)
language plpgsql stable security definer set search_path = public as $$
declare b record; lim record;
begin
  select subscription_plan, extra_tellers, extra_branches, extra_products into b from public.businesses where id = p_business_id;
  select * into lim from public.plan_limits(coalesce(b.subscription_plan, 'Free'));
  max_tellers  := case when lim.max_tellers  >= 999999 then lim.max_tellers  else lim.max_tellers  + coalesce(b.extra_tellers, 0)  end;
  max_branches := case when lim.max_branches >= 999999 then lim.max_branches else lim.max_branches + coalesce(b.extra_branches, 0) end;
  max_products := case when lim.max_products >= 999999 then lim.max_products else lim.max_products + coalesce(b.extra_products, 0) end;
end $$;
revoke all on function public.business_limits(uuid) from public, anon;
grant execute on function public.business_limits(uuid) to authenticated;

-- Same three triggers as 20261005180204_plan_tier_limits.sql; only the limit lookup changed.
create or replace function public.enforce_team_limit() returns trigger
language plpgsql set search_path = public as $$
declare lim record; biz_plan text; current_count int; now_counted boolean; was_counted boolean;
begin
  if new.business_id is null then return new; end if;
  now_counted := coalesce(new.role, 'teller') <> 'admin' and coalesce(new.active, true);
  if not now_counted then return new; end if;
  if tg_op = 'UPDATE' then
    was_counted := old.business_id is not distinct from new.business_id
                   and coalesce(old.role, 'teller') <> 'admin' and coalesce(old.active, true);
    if was_counted then return new; end if;
  end if;
  select subscription_plan into biz_plan from public.businesses where id = new.business_id;
  select * into lim from public.business_limits(new.business_id);
  select count(*) into current_count from public.profiles
    where business_id = new.business_id and coalesce(role, 'teller') <> 'admin' and coalesce(active, true) and id <> new.id;
  if current_count >= lim.max_tellers then
    raise exception 'Teller limit reached for the % plan (max % teller(s)). Upgrade your plan to add more.',
      coalesce(biz_plan, 'Free'), lim.max_tellers;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_branch_limit() returns trigger
language plpgsql set search_path = public as $$
declare lim record; biz_plan text; current_count int;
begin
  if not coalesce(new.active, true) then return new; end if;
  if tg_op = 'UPDATE' and coalesce(old.active, true) and old.business_id = new.business_id then return new; end if;
  select subscription_plan into biz_plan from public.businesses where id = new.business_id;
  select * into lim from public.business_limits(new.business_id);
  select count(*) into current_count from public.branches
    where business_id = new.business_id and coalesce(active, true) and id <> new.id;
  if current_count >= lim.max_branches then
    raise exception 'Branch limit reached for the % plan (max %). Upgrade your plan to add more branches.',
      coalesce(biz_plan, 'Free'), lim.max_branches;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_product_limit() returns trigger
language plpgsql set search_path = public as $$
declare lim record; biz_plan text; current_count int;
begin
  select subscription_plan into biz_plan from public.businesses where id = new.business_id;
  select * into lim from public.business_limits(new.business_id);
  select count(*) into current_count from public.products where business_id = new.business_id;
  if current_count >= lim.max_products then
    raise exception 'Catalog limit reached for the % plan (max % products). Upgrade to Core or above for unlimited products.', coalesce(biz_plan, 'Free'), lim.max_products;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Guard: only the platform admin may change plan fields (as before) or the new overrides.
-- (Replaces guard_business_subscription() from 20261010_subscription_guard.sql.)
-- ---------------------------------------------------------------------------------------------
create or replace function public.guard_business_subscription() returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- SECURITY INVOKER on purpose: current_user is the role the statement really runs as.
  if current_user not in ('authenticated', 'anon') or public.is_platform_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- a business created straight from a client always starts on Free, with no overrides
    new.subscription_plan := 'Free';
    new.subscription_status := 'free';
    new.subscription_started_at := null;
    new.subscription_renews_at := null;
    new.active := true;
    new.suspended_reason := null;
    new.suspended_at := null;
    new.extra_tellers := 0;
    new.extra_branches := 0;
    new.extra_products := 0;
    new.feature_overrides := '{}'::jsonb;
    return new;
  end if;

  if new.subscription_plan       is distinct from old.subscription_plan
  or new.subscription_status     is distinct from old.subscription_status
  or new.subscription_started_at is distinct from old.subscription_started_at
  or new.subscription_renews_at  is distinct from old.subscription_renews_at
  or new.active                  is distinct from old.active
  or new.suspended_reason        is distinct from old.suspended_reason
  or new.suspended_at            is distinct from old.suspended_at
  or new.extra_tellers           is distinct from old.extra_tellers
  or new.extra_branches          is distinct from old.extra_branches
  or new.extra_products          is distinct from old.extra_products
  or new.feature_overrides       is distinct from old.feature_overrides then
    raise exception 'Subscription plans and business limits can only be changed by the platform admin. Use Renew / Upgrade to pay for a plan.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
