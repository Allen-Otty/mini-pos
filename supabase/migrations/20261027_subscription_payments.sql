-- Subscription payments: one row per M-Pesa prompt sent to the PLATFORM till.
-- Applied to the live project as migration "subscription_payments" on 2026-10-27.
-- Written only by the edge functions sub-stk-push / sub-stk-callback / sub-stk-status (service role).

create table public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  requested_by uuid references auth.users(id),
  plan text not null check (plan in ('Core','Control','Core Group','Control Group')),
  billing text not null default 'monthly' check (billing in ('monthly','yearly')),
  amount_expected numeric not null check (amount_expected > 0),
  amount_paid numeric,
  phone text not null,
  env text not null default 'sandbox' check (env in ('sandbox','production')),
  checkout_request_id text unique,
  merchant_request_id text,
  mpesa_receipt text,
  status text not null default 'pending'
    check (status in ('pending','paid','underpaid','failed','cancelled','timeout')),
  result_code integer,
  result_desc text,
  needs_review boolean not null default false,
  review_note text,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index subscription_payments_receipt_uq
  on public.subscription_payments (mpesa_receipt) where mpesa_receipt is not null;
create index subscription_payments_business_idx on public.subscription_payments (business_id, created_at desc);
create index subscription_payments_review_idx on public.subscription_payments (needs_review) where needs_review;
create index subscription_payments_requested_by_idx on public.subscription_payments (requested_by);

alter table public.subscription_payments enable row level security;

-- Read-only from the browser: a business admin sees their own business, platform admins see everything.
create policy subscription_payments_select on public.subscription_payments
  for select to authenticated
  using (
    (select public.is_platform_admin())
    or (
      business_id = (select public.current_business_id())
      and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin')
    )
  );

create or replace function public.subscription_payments_touch()
returns trigger language plpgsql set search_path to 'public' as $$
begin new.updated_at := now(); return new; end; $$;

create trigger subscription_payments_touch_trg
  before update on public.subscription_payments
  for each row execute function public.subscription_payments_touch();

-- Atomic apply: row-locked, idempotent, underpayment-safe.
create or replace function public.apply_subscription_payment(
  p_checkout text, p_receipt text, p_amount numeric, p_result_desc text default null
) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  sp public.subscription_payments;
  b public.businesses;
  v_base timestamptz;
begin
  select * into sp from public.subscription_payments where checkout_request_id = p_checkout for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_checkout');
  end if;

  if sp.status in ('paid','underpaid') then
    return jsonb_build_object('ok', true, 'already', true, 'status', sp.status);
  end if;

  if p_receipt is not null and exists (
    select 1 from public.subscription_payments where mpesa_receipt = p_receipt and id <> sp.id
  ) then
    update public.subscription_payments
      set status = 'failed', needs_review = true,
          review_note = 'Receipt ' || p_receipt || ' already used on another payment',
          result_desc = p_result_desc
      where id = sp.id;
    return jsonb_build_object('ok', false, 'reason', 'duplicate_receipt');
  end if;

  if p_amount is null or p_amount < sp.amount_expected then
    update public.subscription_payments
      set status = 'underpaid', amount_paid = p_amount, mpesa_receipt = p_receipt,
          result_code = 0, result_desc = p_result_desc, needs_review = true,
          review_note = 'Paid ' || coalesce(p_amount::text,'?') || ' but ' || sp.amount_expected::text || ' was due. Plan NOT upgraded.'
      where id = sp.id;
    return jsonb_build_object('ok', true, 'status', 'underpaid');
  end if;

  select * into b from public.businesses where id = sp.business_id for update;
  if not found then
    update public.subscription_payments
      set status = 'paid', amount_paid = p_amount, mpesa_receipt = p_receipt, result_code = 0,
          result_desc = p_result_desc, needs_review = true, review_note = 'Business no longer exists'
      where id = sp.id;
    return jsonb_build_object('ok', false, 'reason', 'business_missing');
  end if;

  v_base := case when b.subscription_plan = sp.plan and b.subscription_renews_at > now()
                 then b.subscription_renews_at else now() end;

  update public.businesses
    set subscription_plan = sp.plan,
        subscription_status = 'active',
        subscription_started_at = coalesce(subscription_started_at, now()),
        subscription_renews_at = v_base + (case when sp.billing = 'yearly' then interval '365 days' else interval '30 days' end)
    where id = sp.business_id;

  update public.subscription_payments
    set status = 'paid', amount_paid = p_amount, mpesa_receipt = p_receipt, result_code = 0,
        result_desc = p_result_desc, applied_at = now(),
        needs_review = (p_amount > sp.amount_expected),
        review_note = case when p_amount > sp.amount_expected
                           then 'Overpaid by ' || (p_amount - sp.amount_expected)::text || '. Plan upgraded.' else null end
    where id = sp.id;

  insert into public.audit_log (business_id, actor_id, actor_role, action, target_table, target_id, details)
  values (sp.business_id, sp.requested_by, 'system', 'subscription_payment_applied', 'subscription_payments', sp.id::text,
          jsonb_build_object('plan', sp.plan, 'billing', sp.billing, 'amount', p_amount, 'receipt', p_receipt));

  return jsonb_build_object('ok', true, 'status', 'paid');
end; $$;

create or replace function public.fail_subscription_payment(
  p_checkout text, p_status text, p_result_code integer default null, p_result_desc text default null
) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  if p_status not in ('failed','cancelled','timeout') then
    raise exception 'invalid status %', p_status;
  end if;
  update public.subscription_payments
    set status = p_status, result_code = p_result_code, result_desc = p_result_desc
    where checkout_request_id = p_checkout and status = 'pending';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'updated', n);
end; $$;

-- Server-only: browsers must never be able to call these.
revoke all on function public.apply_subscription_payment(text,text,numeric,text) from public, anon, authenticated;
revoke all on function public.fail_subscription_payment(text,text,integer,text) from public, anon, authenticated;
grant execute on function public.apply_subscription_payment(text,text,numeric,text) to service_role;
grant execute on function public.fail_subscription_payment(text,text,integer,text) to service_role;
revoke all on function public.subscription_payments_touch() from public, anon, authenticated;
