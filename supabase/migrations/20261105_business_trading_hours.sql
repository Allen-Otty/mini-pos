-- Trading hours: admin sets opening/closing time; tellers can't sell outside them (enforced in sell.html).
-- Off by default. Safe to re-run.
alter table public.businesses
  add column if not exists hours_enabled boolean not null default false,
  add column if not exists opening_time text not null default '08:00',
  add column if not exists closing_time text not null default '21:00';
