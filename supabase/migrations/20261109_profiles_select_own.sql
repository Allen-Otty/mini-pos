-- A platform admin "testing as" another business (platform_active_business) could not read their OWN profile row,
-- because profiles_select_same_business compares business_id with current_business_id(). The app then treated them
-- as signed out and returned to the landing page right after login. Always allow a user to read their own row.
create policy profiles_select_own on public.profiles for select to authenticated using (id = (select auth.uid()));
