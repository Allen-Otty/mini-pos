-- Dogo POS — allow three more business types: Agrovet, Boutique, Wines & Spirits.
-- Purely additive: every value that was allowed before is still allowed, so no existing business is affected.
-- Safe to run more than once.
alter table public.businesses drop constraint if exists businesses_business_type_check;
alter table public.businesses add constraint businesses_business_type_check
  check (business_type = any (array['Retail','Wholesale','Supermarket','SME','Hotel','Hardware','Kiosk',
                                    'Restaurant','Pharmacy','Service','Agrovet','Boutique','Wines & Spirits']::text[]));
