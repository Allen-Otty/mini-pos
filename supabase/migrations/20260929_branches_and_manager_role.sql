-- Dogo POS — branches + manager role
-- Run this once in the Supabase SQL editor (or `supabase db push` if you use the CLI).
-- Nothing in this repo can run it automatically: the app only ever holds the
-- publishable anon key, which cannot create tables or alter RLS.
--
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / conditional checks.

-- 1. Branches belong to a business. A NULL branch_id on profiles/products/sales
--    means "not assigned to a branch" (today's single-branch behaviour keeps working).
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  location text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.branches enable row level security;

drop policy if exists "branches_select_own_business" on public.branches;
create policy "branches_select_own_business" on public.branches
  for select using (business_id = current_business_id());

drop policy if exists "branches_admin_write" on public.branches;
create policy "branches_admin_write" on public.branches
  for all using (
    business_id = current_business_id()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  ) with check (
    business_id = current_business_id()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- 2. Which branch a team member is assigned to. Nullable — an unassigned
--    teller/manager can still work exactly as they do today.
alter table public.profiles add column if not exists branch_id uuid references public.branches(id);

-- 3. 'manager' joins 'admin' / 'teller' as a role. profiles.role is a plain text
--    column in this schema (no enum/check constraint to alter) — the app enforces
--    valid values, same as it already does for 'admin' and 'teller'.
--    A manager is scoped to their own branch at the APPLICATION level only
--    (team.html limits who they see/add) — this migration does not add
--    branch-scoped RLS to products/sales/expenses/etc. Data across the whole
--    business remains visible business-wide, as it is today. Ask if you also
--    want per-branch data isolation — that is a larger, separate change
--    touching most tables' RLS policies, not just team management.

-- 4. Let an Admin see every profile in their business (needed for the Team
--    page's list/edit/deactivate — matches the existing pattern used elsewhere).
drop policy if exists "profiles_admin_manage_own_business" on public.profiles;
create policy "profiles_admin_manage_own_business" on public.profiles
  for update using (
    business_id = current_business_id()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  ) with check (business_id = current_business_id());
