-- Compatibility migration for databases still using the original 90-minute checks.
-- The public API caps user requests at 150; retain the existing admin range of 1440.
-- Does not change existing sessions, recorded payments, or app-unlock prices.
begin;

alter table public.session_requests
  drop constraint if exists session_requests_daily_limit_minutes_check;
alter table public.session_requests
  add constraint session_requests_daily_limit_minutes_check
  check (daily_limit_minutes between 5 and 1440);

alter table public.sessions
  drop constraint if exists sessions_daily_limit_minutes_check;
alter table public.sessions
  add constraint sessions_daily_limit_minutes_check
  check (daily_limit_minutes between 5 and 1440);

commit;
