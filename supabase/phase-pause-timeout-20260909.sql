-- Apply before deploying the backend. Existing active pauses >= 24 hours will be revoked.
begin;

create index if not exists sessions_active_paused_at_idx
  on public.sessions (paused_at) where status = 'active' and paused_at is not null;

-- Guard even a resume racing the scheduler at the deadline. Never extend an overdue pause.
create or replace function public.guard_session_pause_deadline()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'active' and old.paused_at is not null
     and old.paused_at <= clock_timestamp() - interval '24 hours' then
    new.status := 'revoked';
    new.paused_at := old.paused_at;
    new.ends_at := old.ends_at;
    new.config_version := greatest(new.config_version, old.config_version + 1);
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger if exists guard_session_pause_deadline on public.sessions;
create trigger guard_session_pause_deadline
before update on public.sessions
for each row execute function public.guard_session_pause_deadline();

create or replace function public.revoke_timed_out_session_pauses(target_session_id uuid default null)
returns integer
language sql
security definer
set search_path = public
as $$
  with revoked as (
    update public.sessions
      set status = 'revoked', config_version = config_version + 1, updated_at = clock_timestamp()
      where status = 'active'
        and paused_at <= clock_timestamp() - interval '24 hours'
        and (target_session_id is null or id = target_session_id)
      returning id
  ), cancelled as (
    update public.device_remote_actions set status = 'cancelled'
      where status = 'pending' and session_id in (select id from revoked)
      returning id
  )
  select count(*)::integer from revoked;
$$;

revoke all on function public.guard_session_pause_deadline() from public, anon, authenticated;
revoke all on function public.revoke_timed_out_session_pauses(uuid) from public, anon, authenticated;
grant execute on function public.revoke_timed_out_session_pauses(uuid) to service_role;

-- This job also runs when no device or admin is online.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'revoke-session-pauses-after-24h',
  '* * * * *',
  'select public.revoke_timed_out_session_pauses();'
);

select public.revoke_timed_out_session_pauses();
commit;

