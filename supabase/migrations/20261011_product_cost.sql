-- Dogo POS — buying cost per product, so stock value can be shown at what the stock cost you
-- (not at its selling price). NULL = not entered yet. Additive and safe to re-run.
alter table public.products add column if not exists cost numeric check (cost is null or cost >= 0);
