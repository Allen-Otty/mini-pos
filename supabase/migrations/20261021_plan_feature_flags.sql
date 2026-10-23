-- Adds the newer feature switches to plan_definitions.flags (additive, safe to re-run).
-- Existing keys are kept; only missing keys are filled. Edit per plan in Admin Console > Plans & Pricing.
update public.plan_definitions pd
set flags = coalesce(pd.flags, '{}'::jsonb) || (
  jsonb_build_object(
    'invoicing',            pd.plan in ('Control','Core Group','Control Group'),
    'purchasesSuppliers',   pd.plan <> 'Free',
    'scanInvoice',          pd.plan in ('Control','Control Group'),
    'inventoryControl',     pd.plan in ('Control','Core Group','Control Group'),
    'customers',            true,
    'accounting',           pd.plan in ('Control','Control Group'),
    'receiptCustomisation', pd.plan <> 'Free',
    'csvExport',            pd.plan <> 'Free'
  ) - (select coalesce(array_agg(k), '{}') from jsonb_object_keys(coalesce(pd.flags,'{}'::jsonb)) k)
),
updated_at = now();
