-- Apply only to the Principessa Lock database. No history is deleted or invented.
-- History records the effective limit (admin base limit plus earned step bonuses).
begin;
alter table public.session_daily_usage
  drop constraint if exists session_daily_usage_limit_minutes_check;
alter table public.session_daily_usage
  add constraint session_daily_usage_limit_minutes_check check (limit_minutes >= 5);
commit;
