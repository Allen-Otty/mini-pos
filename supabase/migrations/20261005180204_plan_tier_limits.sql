-- Copied from production (applied 2026-10-05) so the repo matches the live database.
-- Superseded in effect by 20261006031051_plan_definitions.sql, which redefines plan_limits().
drop function if exists public.plan_limits(text);
create function public.plan_limits(plan text, out max_tellers int, out max_branches int, out max_products int)
language sql immutable set search_path = public as $$
  select case plan
      when 'Control Group' then 999999
      when 'Core Group'    then 999999
      when 'Control'       then 5
      when 'Core'          then 2
      else 0
    end,
    case plan
      when 'Control Group' then 999999
      when 'Core Group'    then 5
      when 'Control'       then 3
      else 1
    end,
    case plan
      when 'Free' then 5
      else 999999
    end;
$$;

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
  select * into lim from public.plan_limits(coalesce(biz_plan, 'Free'));
  select count(*) into current_count from public.profiles
    where business_id = new.business_id and coalesce(role, 'teller') <> 'admin' and coalesce(active, true) and id <> new.id;
  if current_count >= lim.max_tellers then
    raise exception 'Teller limit reached for the % plan (max % teller(s)). Upgrade your plan to add more.',
      coalesce(biz_plan, 'Free'), lim.max_tellers;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_team_limit on public.profiles;
create trigger trg_enforce_team_limit
  before insert or update of role, active, business_id on public.profiles
  for each row execute function public.enforce_team_limit();

create or replace function public.enforce_branch_limit() returns trigger
language plpgsql set search_path = public as $$
declare lim record; biz_plan text; current_count int;
begin
  if not coalesce(new.active, true) then return new; end if;
  if tg_op = 'UPDATE' and coalesce(old.active, true) and old.business_id = new.business_id then return new; end if;
  select subscription_plan into biz_plan from public.businesses where id = new.business_id;
  select * into lim from public.plan_limits(coalesce(biz_plan, 'Free'));
  select count(*) into current_count from public.branches
    where business_id = new.business_id and coalesce(active, true) and id <> new.id;
  if current_count >= lim.max_branches then
    raise exception 'Branch limit reached for the % plan (max %). Upgrade your plan to add more branches.',
      coalesce(biz_plan, 'Free'), lim.max_branches;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_branch_limit on public.branches;
create trigger trg_enforce_branch_limit
  before insert or update of active, business_id on public.branches
  for each row execute function public.enforce_branch_limit();

create or replace function public.enforce_product_limit() returns trigger
language plpgsql set search_path = public as $$
declare lim record; biz_plan text; current_count int;
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
