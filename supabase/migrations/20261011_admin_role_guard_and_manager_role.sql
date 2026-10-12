-- Dogo POS — only the platform admin can create Admins; Manager becomes a saveable role.
-- 1) profiles.role only allowed 'admin' and 'teller', so choosing Manager on the Team page failed.
-- 2) A shop admin could promote any teller to Admin through the API. Admins are not counted in the
--    teller limit, so that was a way around the plan limits (e.g. Core = 1 admin + 2 tellers).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role = any (array['admin'::text, 'manager'::text, 'teller'::text]));

create or replace function public.guard_profile_role() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role = 'admin' and old.role is distinct from 'admin'
     and current_user in ('authenticated', 'anon')
     and not public.is_platform_admin() then
    raise exception 'Only the platform admin can make someone an Admin. Use the Teller or Manager role.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_profile_role() from public, anon, authenticated;

drop trigger if exists trg_guard_profile_role on public.profiles;
create trigger trg_guard_profile_role before update of role on public.profiles
  for each row execute function public.guard_profile_role();
