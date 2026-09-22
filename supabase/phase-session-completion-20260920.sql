-- Principessa Lock only. Requires phase-pause-timeout-20260909.sql.
-- Completes already elapsed, unpaused active sessions without deleting any data.
begin;

create index if not exists sessions_active_unpaused_end_idx
  on public.sessions (ends_at) where status = 'active' and paused_at is null;

create or replace function public.complete_elapsed_sessions(target_session_id uuid default null)
returns integer
language sql
security definer
set search_path = public
as $$
  with completed as (
    update public.sessions
      set status = 'completed', config_version = config_version + 1, updated_at = clock_timestamp()
      where status = 'active'
        and paused_at is null
        and ends_at <= statement_timestamp()
        and (target_session_id is null or id = target_session_id)
      returning id
  ), cancelled as (
    update public.device_remote_actions set status = 'cancelled'
      where status = 'pending' and session_id in (select id from completed)
      returning id
  )
  select count(*)::integer from completed;
$$;

revoke all on function public.complete_elapsed_sessions(uuid) from public, anon, authenticated;
grant execute on function public.complete_elapsed_sessions(uuid) to service_role;

-- Keep paused-time credit and the existing independent 24-hour pause revocation.
-- A sleeping/offline phone or a closed admin app does not prevent this sweep.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'complete-elapsed-sessions',
  '* * * * *',
  'select public.complete_elapsed_sessions();'
);

select public.complete_elapsed_sessions();
commit;
