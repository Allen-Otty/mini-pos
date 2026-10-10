-- Subscription guard: plans can only be changed by the platform admin, expiring plans
-- are flagged 3 days ahead, and an expired plan locks the business.
--
-- Safe to re-run (everything is create-or-replace / drop-if-exists).
--
-- Roles: a browser/app session reaches Postgres as role 'authenticated' (or 'anon').
-- Edge functions use 'service_role', SECURITY DEFINER functions run as their owner, and
-- the SQL editor / jobs have no auth.uid(). Only the first kind is ever restricted below.

-- ---------------------------------------------------------------------------------------
-- 1. Business admins can no longer edit plan or suspension fields
-- ---------------------------------------------------------------------------------------
create or replace function public.guard_business_subscription() returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- SECURITY INVOKER on purpose: current_user is the role the statement really runs as.
  -- (Inside a SECURITY DEFINER function it would always be the function owner.)
  if current_user not in ('authenticated', 'anon') or public.is_platform_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- a business created straight from a client always starts on Free
    new.subscription_plan := 'Free';
    new.subscription_status := 'free';
    new.subscription_started_at := null;
    new.subscription_renews_at := null;
    new.active := true;
    new.suspended_reason := null;
    new.suspended_at := null;
    return new;
  end if;

  if new.subscription_plan       is distinct from old.subscription_plan
  or new.subscription_status     is distinct from old.subscription_status
  or new.subscription_started_at is distinct from old.subscription_started_at
  or new.subscription_renews_at  is distinct from old.subscription_renews_at
  or new.active                  is distinct from old.active
  or new.suspended_reason        is distinct from old.suspended_reason
  or new.suspended_at            is distinct from old.suspended_at then
    raise exception 'Subscription plans can only be changed by the platform admin. Use Renew / Upgrade to pay for a plan.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_business_subscription on public.businesses;
create trigger trg_guard_business_subscription
  before insert or update on public.businesses
  for each row execute function public.guard_business_subscription();

-- ---------------------------------------------------------------------------------------
-- 2. One server-side answer to "is this business expiring / expired?" (server clock)
--    Free plans never expire. Trials expire like paid plans.
-- ---------------------------------------------------------------------------------------
create or replace function public.subscription_state() returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  b public.businesses;
  v_now timestamptz := now();
  v_plan text;
  v_expired boolean;
  v_expiring boolean;
begin
  select * into b from public.businesses where id = public.current_business_id();
  if not found then
    return jsonb_build_object('plan', 'Free', 'status', 'free', 'expired', false, 'expiring', false,
                              'days_left', null, 'renews_at', null, 'now', v_now, 'bypass', public.is_platform_admin());
  end if;
  v_plan := coalesce(b.subscription_plan, 'Free');
  v_expired  := v_plan <> 'Free' and b.subscription_renews_at is not null and b.subscription_renews_at < v_now;
  v_expiring := v_plan <> 'Free' and b.subscription_renews_at is not null and not v_expired
                and b.subscription_renews_at <= v_now + interval '3 days';
  return jsonb_build_object(
    'plan', v_plan,
    'status', coalesce(b.subscription_status, 'free'),
    'renews_at', b.subscription_renews_at,
    'now', v_now,
    'expired', v_expired,
    'expiring', v_expiring,
    'days_left', case when b.subscription_renews_at is null then null
                      else ceil(extract(epoch from (b.subscription_renews_at - v_now)) / 86400) end,
    'bypass', public.is_platform_admin()
  );
end;
$$;

revoke all on function public.subscription_state() from public, anon;
grant execute on function public.subscription_state() to authenticated;

-- ---------------------------------------------------------------------------------------
-- 3. Free trial, granted by the server instead of the browser. One trial per business.
-- ---------------------------------------------------------------------------------------
create or replace function public.start_free_trial(p_plan text) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_biz uuid := public.current_business_id();
  b public.businesses;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not (public.is_admin() or public.is_platform_admin()) then
    raise exception 'Only the business Admin can start a trial' using errcode = '42501';
  end if;
  if p_plan is null or p_plan not in ('Core', 'Control', 'Core Group', 'Control Group') then
    raise exception 'Unknown plan: %', coalesce(p_plan, 'null') using errcode = '22023';
  end if;

  select * into b from public.businesses where id = v_biz for update;
  if not found then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;
  if b.subscription_started_at is not null or coalesce(b.subscription_plan, 'Free') <> 'Free' then
    raise exception 'A free trial has already been used on this business. Please subscribe to continue.'
      using errcode = '42501';
  end if;

  update public.businesses
     set subscription_plan = p_plan,
         subscription_status = 'trial',
         subscription_started_at = now(),
         subscription_renews_at = now() + interval '7 days'
   where id = v_biz;

  return public.subscription_state();
end;
$$;

revoke all on function public.start_free_trial(text) from public, anon;
grant execute on function public.start_free_trial(text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- 4. Lock: once the plan has expired, a signed-in user cannot write business data.
--    Reads stay open (so the Renew screen works and nothing is lost). The platform admin,
--    edge functions (service_role) and jobs are never locked.
-- ---------------------------------------------------------------------------------------
create or replace function public.enforce_subscription_active() returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_biz uuid;
  v_plan text;
  v_renews timestamptz;
  v_grace interval := interval '0';
begin
  if auth.uid() is null or public.is_platform_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_name = 'sale_items' then
    select business_id into v_biz from public.sales
     where id = case when tg_op = 'DELETE' then old.sale_id else new.sale_id end;
  elsif tg_op = 'DELETE' then
    v_biz := old.business_id;
  else
    v_biz := new.business_id;
  end if;

  -- The screen locks the moment the plan ends. A sale rung up on a till while it was still
  -- unlocked can reach the server a little later (offline queue), together with the stock change
  -- and shift records that go with it, so those get a 48 hour sync window. Everything else
  -- (new products, customers, expenses, tables, kitchen tickets, branches) is refused at once.
  if tg_table_name in ('sales', 'sale_items', 'shift_sessions')
     or (tg_table_name = 'products' and tg_op = 'UPDATE') then
    v_grace := interval '48 hours';
  end if;

  if v_biz is not null then
    select coalesce(subscription_plan, 'Free'), subscription_renews_at
      into v_plan, v_renews
      from public.businesses where id = v_biz;
    if v_plan is not null and v_plan <> 'Free' and v_renews is not null and v_renews + v_grace < now() then
      raise exception 'SUBSCRIPTION_EXPIRED: Your % plan expired on %. Renew to keep using Dogo POS.',
        v_plan, to_char(v_renews at time zone 'Africa/Nairobi', 'DD Mon YYYY')
        using errcode = '42501';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['sales', 'sale_items', 'products', 'customers', 'expenses',
                           'tables', 'kitchen_tickets', 'shift_sessions', 'branches']
  loop
    execute format('drop trigger if exists trg_enforce_subscription_active on public.%I', t);
    execute format(
      'create trigger trg_enforce_subscription_active
         before insert or update or delete on public.%I
         for each row execute function public.enforce_subscription_active()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------
-- 5. Approving a payment claim now extends from the current expiry when the same plan is
--    still running, so paying during the 3-day warning does not throw away unused days.
--    (Everything else in this function is unchanged.)
-- ---------------------------------------------------------------------------------------
create or replace function public.apply_subscription_claim() returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    update public.businesses
      set subscription_plan = new.plan,
          subscription_status = 'active',
          subscription_started_at = coalesce(subscription_started_at, now()),
          subscription_renews_at =
            (case when subscription_plan = new.plan and subscription_renews_at > now()
                  then subscription_renews_at else now() end)
            + (case when new.billing = 'yearly' then interval '365 days' else interval '30 days' end)
      where id = new.business_id;
    new.reviewed_at = now();
  elsif new.status = 'rejected' and old.status is distinct from 'rejected' then
    new.reviewed_at = now();
  end if;
  return new;
end;
$$;
