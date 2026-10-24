-- Dogo AI assistant + client contacts
-- Run in the Supabase SQL Editor. Safe to re-run.

-- ───────────── 1. Client contacts next to accounts ─────────────
alter table public.businesses
  add column if not exists owner_email text,
  add column if not exists owner_phone text,
  add column if not exists contact_notes text,
  add column if not exists last_contacted_at timestamptz;

-- Backfill owner email from the login account (emails live in auth.users)
update public.businesses b
   set owner_email = u.email
  from auth.users u
 where u.id = b.owner_id and b.owner_email is null;

-- Backfill phone only from numbers the owner already gave us (receipt phone / payment claims)
update public.businesses b
   set owner_phone = coalesce(
         (select c.phone from public.subscription_claims c
           where c.business_id = b.id and coalesce(c.phone,'') <> ''
           order by c.created_at desc limit 1),
         nullif(split_part(b.receipt_phone, '/', 1), ''))
 where b.owner_phone is null;

-- New signups always get their login email stored, even if the signup function is old
create or replace function public.businesses_fill_owner_email()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  if new.owner_email is null and new.owner_id is not null then
    select email into new.owner_email from auth.users where id = new.owner_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_businesses_owner_email on public.businesses;
create trigger trg_businesses_owner_email before insert on public.businesses
  for each row execute function public.businesses_fill_owner_email();

-- Platform admin: every client's contact details
create or replace function public.platform_contacts()
returns table (business_id uuid, name text, business_type text, owner_name text,
               owner_email text, owner_phone text, contact_notes text,
               last_contacted_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'platform admin only'; end if;
  return query
    select b.id, b.name, b.business_type,
           (select p.full_name from public.profiles p where p.id = b.owner_id),
           b.owner_email, b.owner_phone, b.contact_notes, b.last_contacted_at, b.created_at
      from public.businesses b order by b.created_at desc;
end $$;

create or replace function public.platform_note_contact(p_business uuid, p_note text default null, p_phone text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'platform admin only'; end if;
  update public.businesses set
    last_contacted_at = now(),
    contact_notes = coalesce(p_note, contact_notes),
    owner_phone = coalesce(nullif(trim(p_phone), ''), owner_phone)
  where id = p_business;
end $$;

-- A shop owner adds / fixes their own contact number (existing accounts)
create or replace function public.set_my_contact(p_phone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_business_id() is null then raise exception 'not signed in to a business'; end if;
  update public.businesses set owner_phone = nullif(trim(p_phone), '')
   where id = public.current_business_id();
end $$;

-- ───────────── 2. AI configuration (server-side only) ─────────────
create table if not exists public.ai_config (
  id int primary key default 1 check (id = 1),
  provider text not null default 'gemini',          -- gemini | groq | openrouter
  model text,
  api_key text,
  enabled boolean not null default false,
  admin_enabled boolean not null default true,
  business_enabled boolean not null default true,
  help_enabled boolean not null default true,
  temperature numeric not null default 0.4,
  daily_limit_per_business int not null default 30,
  daily_limit_help int not null default 200,
  knowledge text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.ai_config (id) values (1) on conflict do nothing;

create table if not exists public.ai_usage (
  id bigserial primary key,
  at timestamptz not null default now(),
  mode text, business_id uuid, user_id uuid, provider text, ok boolean, note text
);
create index if not exists ai_usage_at on public.ai_usage (at);

-- Nobody reads these from the browser: the key never leaves the server.
alter table public.ai_config enable row level security;
alter table public.ai_usage  enable row level security;
revoke all on public.ai_config, public.ai_usage from anon, authenticated;
revoke all on sequence public.ai_usage_id_seq from anon, authenticated;

create or replace function public.ai_get_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.ai_config%rowtype;
begin
  if not public.is_platform_admin() then raise exception 'platform admin only'; end if;
  select * into c from public.ai_config where id = 1;
  return jsonb_build_object(
    'provider', c.provider, 'model', c.model, 'enabled', c.enabled,
    'admin_enabled', c.admin_enabled, 'business_enabled', c.business_enabled, 'help_enabled', c.help_enabled,
    'temperature', c.temperature, 'daily_limit_per_business', c.daily_limit_per_business,
    'daily_limit_help', c.daily_limit_help, 'knowledge', c.knowledge,
    'key_set', coalesce(c.api_key, '') <> '',
    'key_hint', case when coalesce(c.api_key,'') <> '' then '…' || right(c.api_key, 4) end,
    'calls_today', (select count(*) from public.ai_usage where at > now() - interval '1 day'));
end $$;

create or replace function public.ai_set_config(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'platform admin only'; end if;
  update public.ai_config set
    provider = coalesce(p->>'provider', provider),
    model = case when p ? 'model' then nullif(p->>'model','') else model end,
    api_key = case when coalesce(p->>'clear_key','') = 'true' then null
                   when coalesce(p->>'api_key','') <> '' then p->>'api_key' else api_key end,
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    admin_enabled = coalesce((p->>'admin_enabled')::boolean, admin_enabled),
    business_enabled = coalesce((p->>'business_enabled')::boolean, business_enabled),
    help_enabled = coalesce((p->>'help_enabled')::boolean, help_enabled),
    temperature = coalesce((p->>'temperature')::numeric, temperature),
    daily_limit_per_business = coalesce((p->>'daily_limit_per_business')::int, daily_limit_per_business),
    daily_limit_help = coalesce((p->>'daily_limit_help')::int, daily_limit_help),
    knowledge = coalesce(p->>'knowledge', knowledge),
    updated_at = now()
  where id = 1;
end $$;

-- ───────────── 3. Live context the AI reads (read-only) ─────────────
create or replace function public.ai_platform_snapshot()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_platform_admin() then raise exception 'platform admin only'; end if;
  select jsonb_build_object(
    'generated_at', now(),
    'businesses_total', (select count(*) from businesses),
    'businesses_active', (select count(*) from businesses where active),
    'new_businesses_7d', (select count(*) from businesses where created_at > now() - interval '7 days'),
    'new_businesses_30d', (select count(*) from businesses where created_at > now() - interval '30 days'),
    'plans', (select coalesce(jsonb_object_agg(plan, n), '{}') from
              (select coalesce(subscription_plan,'Free') plan, count(*) n from businesses group by 1) x),
    'pending_payment_claims', (select count(*) from subscription_claims where status = 'pending'),
    'businesses', (select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]') from (
        select b.name, b.business_type, b.active, b.subscription_plan, b.subscription_status,
               b.subscription_renews_at, b.created_at, b.owner_email, b.owner_phone, b.last_contacted_at,
               (select count(*) from profiles p where p.business_id = b.id) staff,
               (select count(*) from products p where p.business_id = b.id and not coalesce(p.archived,false)) products,
               (select count(*) from sales s where s.business_id = b.id and s.created_at > now() - interval '7 days') sales_7d,
               (select coalesce(sum(total),0) from sales s where s.business_id = b.id and s.created_at > now() - interval '30 days') sales_value_30d,
               (select max(created_at) from sales s where s.business_id = b.id) last_sale_at
          from businesses b order by b.created_at desc limit 60) t),
    'sales_30d', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(total),0)) from sales where created_at > now() - interval '30 days'),
    'security', jsonb_build_object(
      'failed_logins_24h', (select count(*) from login_history where success = false and created_at > now() - interval '24 hours'),
      'failed_logins_by_business_24h', (select coalesce(jsonb_agg(row_to_json(f)), '[]') from (
          select business_id, count(*) n from login_history where success = false and created_at > now() - interval '24 hours'
          group by 1 order by 2 desc limit 5) f),
      'new_device_logins_24h', (select count(*) from login_history where is_new_device and created_at > now() - interval '24 hours'),
      'offhours_logins_24h', (select count(*) from login_history where success and created_at > now() - interval '24 hours'
          and extract(hour from created_at at time zone 'Africa/Nairobi') < 5),
      'locked_accounts', (select count(*) from profiles where locked_until > now()),
      'payment_failures_24h', (select count(*) from payment_requests where status not in ('success','pending') and created_at > now() - interval '24 hours'),
      'stk_bursts_1h', (select count(*) from (select phone from payment_requests where created_at > now() - interval '1 hour'
          group by phone having count(*) >= 4) z),
      'zero_amount_requests_7d', (select count(*) from payment_requests where coalesce(amount,0) <= 0 and created_at > now() - interval '7 days'),
      'duplicate_mpesa_receipts', (select count(*) from (select mpesa_receipt from payment_requests where mpesa_receipt is not null
          group by 1 having count(*) > 1) d),
      'platform_admins', (select count(*) from platform_admins),
      'role_or_suspend_changes_7d', (select count(*) from audit_log where created_at > now() - interval '7 days'
          and (action ilike '%role%' or action ilike '%suspend%' or action ilike '%delete%')),
      'recent_audit', (select coalesce(jsonb_agg(row_to_json(a)), '[]') from (
          select action, actor_role, target_table, created_at from audit_log order by created_at desc limit 15) a))
  ) into r;
  return r;
end $$;

create or replace function public.ai_business_snapshot()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare bid uuid := public.current_business_id(); r jsonb;
begin
  if bid is null then raise exception 'not signed in to a business'; end if;
  select jsonb_build_object(
    'generated_at', now(),
    'business', (select jsonb_build_object('name', name, 'type', business_type, 'plan', subscription_plan) from businesses where id = bid),
    'sales_today', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(total),0)) from sales
                     where business_id = bid and created_at >= date_trunc('day', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'),
    'sales_7d', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(total),0)) from sales where business_id = bid and created_at > now() - interval '7 days'),
    'sales_30d', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(total),0)) from sales where business_id = bid and created_at > now() - interval '30 days'),
    'by_payment_method_30d', (select coalesce(jsonb_agg(row_to_json(m)), '[]') from (
        select coalesce(payment_method,'unknown') method, count(*) n, sum(total) value from sales
         where business_id = bid and created_at > now() - interval '30 days' group by 1 order by 3 desc) m),
    'top_products_30d', (select coalesce(jsonb_agg(row_to_json(t)), '[]') from (
        select si.name, sum(si.qty) qty, sum(si.line_total) value from sale_items si join sales s on s.id = si.sale_id
         where s.business_id = bid and s.created_at > now() - interval '30 days' group by 1 order by 3 desc limit 10) t),
    'low_stock', (select coalesce(jsonb_agg(row_to_json(l)), '[]') from (
        select name, stock, reorder_level from products where business_id = bid and not coalesce(archived,false)
           and stock <= coalesce(reorder_level, 0) order by stock limit 15) l),
    'products_total', (select count(*) from products where business_id = bid and not coalesce(archived,false)),
    'expenses_30d', (select coalesce(sum(amount),0) from expenses where business_id = bid and created_at > now() - interval '30 days'),
    'staff', (select coalesce(jsonb_agg(row_to_json(p)), '[]') from (
        select full_name, role, active from profiles where business_id = bid limit 20) p)
  ) into r;
  return r;
end $$;

grant execute on function public.platform_contacts(), public.platform_note_contact(uuid,text,text),
  public.set_my_contact(text), public.ai_get_config(), public.ai_set_config(jsonb),
  public.ai_platform_snapshot(), public.ai_business_snapshot() to authenticated;
revoke execute on function public.platform_contacts(), public.platform_note_contact(uuid,text,text),
  public.ai_get_config(), public.ai_set_config(jsonb), public.ai_platform_snapshot() from anon;
revoke execute on function public.set_my_contact(text), public.ai_business_snapshot() from anon;
