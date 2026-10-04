-- Shared kitchen tickets for Hotel/Restaurant businesses.
-- Until now tickets lived in each browser's localStorage, so a kitchen screen on a different
-- phone/tablet could never see an order taken on the till. This table makes them shared.
-- Safe to run more than once.

create table if not exists public.kitchen_tickets (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  short_id      text not null,                       -- e.g. #4821, shown on the board
  order_type    text not null default 'DINE IN',     -- DINE IN | TAKEAWAY | DELIVERY
  table_name    text,                                -- optional floor table
  location      text,
  status        text not null default 'pending'
                check (status in ('pending','preparing','ready','served','cancelled')),
  items         jsonb not null default '[]'::jsonb,  -- [{id,name,price,qty,vat,unit,code}]
  total         numeric(12,2) not null default 0,
  paid          boolean not null default false,
  sale_id       uuid,                                -- set when the bill is settled
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists kitchen_tickets_business_status_idx
  on public.kitchen_tickets (business_id, status, created_at desc);

alter table public.kitchen_tickets enable row level security;

-- Everyone in a business (admin, manager, teller) works the same board.
drop policy if exists "kitchen_select_own_business" on public.kitchen_tickets;
create policy "kitchen_select_own_business" on public.kitchen_tickets
  for select using (business_id = current_business_id());

drop policy if exists "kitchen_insert_own_business" on public.kitchen_tickets;
create policy "kitchen_insert_own_business" on public.kitchen_tickets
  for insert with check (business_id = current_business_id());

drop policy if exists "kitchen_update_own_business" on public.kitchen_tickets;
create policy "kitchen_update_own_business" on public.kitchen_tickets
  for update using (business_id = current_business_id())
  with check (business_id = current_business_id());

drop policy if exists "kitchen_delete_own_business" on public.kitchen_tickets;
create policy "kitchen_delete_own_business" on public.kitchen_tickets
  for delete using (business_id = current_business_id());

create or replace function public.kitchen_tickets_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists kitchen_tickets_touch on public.kitchen_tickets;
create trigger kitchen_tickets_touch before update on public.kitchen_tickets
  for each row execute function public.kitchen_tickets_touch();

-- Live updates for the kitchen screen.
do $$ begin
  alter publication supabase_realtime add table public.kitchen_tickets;
exception when duplicate_object then null; when undefined_object then null; end $$;
