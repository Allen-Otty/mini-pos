-- APPLIED to the live database on 2026-11-05 (migration "last_seen_tracking").
-- Last used / seen: the app calls touch_last_seen() on open and every ~5 min while in use (web, Android, Windows).
-- The platform admin console reads platform_last_seen() to show, per business, when it was last used, by whom, on what.
alter table public.profiles
  add column if not exists last_seen_at timestamptz,
  add column if not exists last_seen_platform text;

create or replace function public.touch_last_seen(p_platform text default 'web')
returns void language sql security definer set search_path to 'public'
as $$
  update public.profiles
     set last_seen_at = now(),
         last_seen_platform = case when p_platform in ('web','android','windows','ios') then p_platform else 'web' end
   where id = auth.uid();
$$;
revoke all on function public.touch_last_seen(text) from public, anon;
grant execute on function public.touch_last_seen(text) to authenticated;

create or replace function public.platform_last_seen()
returns table(business_id uuid, last_seen_at timestamptz, last_seen_platform text, last_user text, users_active_7d int, users_total int)
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not public.is_platform_admin() then raise exception 'platform admin only'; end if;
  return query
    select b.id,
           (select max(p.last_seen_at) from public.profiles p where p.business_id = b.id),
           (select p.last_seen_platform from public.profiles p where p.business_id = b.id and p.last_seen_at is not null order by p.last_seen_at desc limit 1),
           (select p.full_name from public.profiles p where p.business_id = b.id and p.last_seen_at is not null order by p.last_seen_at desc limit 1),
           (select count(*)::int from public.profiles p where p.business_id = b.id and p.last_seen_at > now() - interval '7 days'),
           (select count(*)::int from public.profiles p where p.business_id = b.id)
      from public.businesses b;
end $$;
revoke all on function public.platform_last_seen() from public, anon;
grant execute on function public.platform_last_seen() to authenticated;
