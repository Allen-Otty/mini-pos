-- Applied to production on 2026-10-04.
-- Sales can now be paid through the other gateways. Previously only cash/mpesa were allowed, so a
-- KCB / Paystack / Airtel payment would charge the customer and then fail to save the sale.
alter table public.sales drop constraint if exists sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check
  check (payment_method = any (array['cash'::text, 'mpesa'::text, 'kcb'::text, 'paystack'::text, 'airtel'::text]));
