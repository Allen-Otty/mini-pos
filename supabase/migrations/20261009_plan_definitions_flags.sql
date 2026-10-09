-- Dogo POS — per-plan feature toggles for the Admin Console plan editor.
-- plan_definitions (prices, limits, bullet list) already exists in production; this adds the
-- on/off feature flags the app checks (M-Pesa STK, shifts, eTIMS, ...). Additive and safe to re-run.
-- An empty {} means "use the app's built-in defaults for this plan".

alter table public.plan_definitions add column if not exists flags jsonb not null default '{}'::jsonb;

update public.plan_definitions set flags = case plan
  when 'Free' then '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":false,"shifts":false,"restaurantKitchen":false,"profitReports":false,"teamAccounts":false,"etims":false,"advancedStockAlerts":false,"multiBranch":false,"prioritySupport":false}'
  when 'Core' then '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":true,"shifts":true,"restaurantKitchen":true,"profitReports":true,"teamAccounts":true,"etims":false,"advancedStockAlerts":true,"multiBranch":false,"prioritySupport":false}'
  when 'Core Group' then '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":true,"shifts":true,"restaurantKitchen":true,"profitReports":true,"teamAccounts":true,"etims":false,"advancedStockAlerts":true,"multiBranch":true,"prioritySupport":false}'
  else '{"cashSales":true,"basicReceipts":true,"scanner":true,"offlineStorage":true,"mpesaStk":true,"shifts":true,"restaurantKitchen":true,"profitReports":true,"teamAccounts":true,"etims":true,"advancedStockAlerts":true,"multiBranch":true,"prioritySupport":true}'
end::jsonb
where flags = '{}'::jsonb;
