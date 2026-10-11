-- Dogo POS — trigger/helper functions should not be callable from the public API.
-- Trigger functions run from their triggers and need no EXECUTE grant. plan_limits() stays available
-- to signed-in users (the limit triggers call it as the signed-in user) but not to anonymous visitors.
revoke all on function public.apply_subscription_claim() from public, anon, authenticated;
revoke all on function public.enforce_subscription_active() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.plan_limits(text) from public, anon;
grant execute on function public.plan_limits(text) to authenticated;
