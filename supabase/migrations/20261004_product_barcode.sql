-- NOT YET APPLIED. Lets the Products page save a scanned/typed barcode separately from the SKU code.
-- Until this is run the app falls back to using the barcode as the SKU when no SKU is typed.
alter table public.products add column if not exists barcode text;
create index if not exists products_business_barcode_idx on public.products (business_id, barcode) where barcode is not null;
