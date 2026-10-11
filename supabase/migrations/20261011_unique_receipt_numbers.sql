-- Dogo POS — guarantee unique receipt numbers per business.
-- Receipt numbers are built on the device from a count of existing sales, so two devices selling
-- (or syncing) at the same moment could take the same number. This rule gives a sale a fresh number
-- when its number is already used in that business. Older duplicates are left as printed.
create or replace function public.ensure_unique_receipt() returns trigger
language plpgsql security definer
set search_path = public
as $$
declare n bigint;
begin
  if new.business_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || new.business_id::text, 0));
  if new.receipt_no is not null and new.receipt_no <> ''
     and not exists (select 1 from public.sales s where s.business_id = new.business_id and s.receipt_no = new.receipt_no) then
    return new;
  end if;
  select coalesce(max(regexp_replace(receipt_no, '\D', '', 'g')::bigint), 0) + 1 into n
    from public.sales where business_id = new.business_id and receipt_no ~ '^RC-[0-9]+$';
  new.receipt_no := 'RC-' || lpad(n::text, 4, '0');
  return new;
end;
$$;

revoke all on function public.ensure_unique_receipt() from public, anon, authenticated;

drop trigger if exists trg_unique_receipt on public.sales;
create trigger trg_unique_receipt before insert on public.sales
  for each row execute function public.ensure_unique_receipt();
