-- Dogo POS — editable landing page. The Admin Console's click-to-edit mode saves overrides here;
-- the public landing page reads them. One row per edited element (key = its place in the page,
-- suffix @img / @href / @hide for image, link and hidden-state edits). Additive, safe to re-run.

create table if not exists public.landing_content (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.landing_content enable row level security;

drop policy if exists "landing_content_public_read" on public.landing_content;
create policy "landing_content_public_read" on public.landing_content
  for select to anon, authenticated using (true);

drop policy if exists "landing_content_platform_admin_write" on public.landing_content;
create policy "landing_content_platform_admin_write" on public.landing_content
  for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

grant select on public.landing_content to anon, authenticated;
grant insert, update, delete on public.landing_content to authenticated;

create or replace function public.landing_content_touch() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); new.updated_by = auth.uid(); return new; end $$;
drop trigger if exists landing_content_touch on public.landing_content;
create trigger landing_content_touch before insert or update on public.landing_content
  for each row execute function public.landing_content_touch();

-- Public bucket for images uploaded through the editor (only platform admins can upload).
insert into storage.buckets (id, name, public) values ('landing-assets', 'landing-assets', true)
on conflict (id) do update set public = true;

drop policy if exists "landing_assets_admin_insert" on storage.objects;
create policy "landing_assets_admin_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'landing-assets' and public.is_platform_admin());
drop policy if exists "landing_assets_admin_update" on storage.objects;
create policy "landing_assets_admin_update" on storage.objects for update to authenticated
  using (bucket_id = 'landing-assets' and public.is_platform_admin());
drop policy if exists "landing_assets_admin_delete" on storage.objects;
create policy "landing_assets_admin_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'landing-assets' and public.is_platform_admin());
