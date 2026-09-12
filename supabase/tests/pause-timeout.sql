-- Run on a staging database AFTER phase-pause-timeout-20260909.sql.
-- Uses isolated fixtures only; all fixture writes are rolled back.
begin;
do $$
declare
  device_uuid uuid := gen_random_uuid();
  request_uuid uuid;
  session_uuid uuid;
  original_end timestamptz := clock_timestamp() + interval '1 day';
  pause_start timestamptz;
  result_row public.sessions%rowtype;
  changed integer;
  scenario integer;
begin
  if has_function_privilege('anon', 'public.revoke_timed_out_session_pauses(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.revoke_timed_out_session_pauses(uuid)', 'execute') then
    raise exception 'Public clients must not be able to revoke sessions';
  end if;
  insert into public.devices (id, device_name) values (device_uuid, 'pause-test-' || device_uuid);
  for scenario in 0..4 loop
    request_uuid := gen_random_uuid();
    session_uuid := gen_random_uuid();
    pause_start := case scenario
      when 0 then null
      when 1 then clock_timestamp() - interval '23 hours'
      when 2 then clock_timestamp() - interval '24 hours'
      else clock_timestamp() - interval '3 days'
    end;
    insert into public.session_requests (id, device_name, requested_days, daily_limit_minutes)
      values (request_uuid, 'pause-test-' || request_uuid, 1, 30);
    insert into public.sessions (id, request_id, device_id, session_days, daily_limit_minutes, starts_at, ends_at, paused_at)
      values (session_uuid, request_uuid, device_uuid, 1, 30, clock_timestamp() - interval '1 hour', original_end, pause_start);
    insert into public.device_remote_actions (session_id, device_id, action_type)
      values (session_uuid, device_uuid, 'force_lock');

    if scenario = 4 then
      -- Simulate a resume that crosses the deadline after its read, before its update.
      update public.sessions set paused_at = null, ends_at = original_end + interval '3 days'
        where id = session_uuid;
    else
      changed := public.revoke_timed_out_session_pauses(session_uuid);
      if changed <> case when scenario >= 2 then 1 else 0 end then
        raise exception 'Unexpected revoke count for scenario %', scenario;
      end if;
    end if;

    select * into strict result_row from public.sessions where id = session_uuid;
    if scenario >= 2 then
      if result_row.status <> 'revoked' or result_row.ends_at <> original_end or result_row.config_version <> 2 then
        raise exception 'Overdue pause was extended or not revoked: scenario %', scenario;
      end if;
      if public.revoke_timed_out_session_pauses(session_uuid) <> 0 then
        raise exception 'Revocation must be idempotent';
      end if;
      if scenario <> 4 and exists (select 1 from public.device_remote_actions where session_id = session_uuid and status = 'pending') then
        raise exception 'Timeout sweep must cancel pending actions';
      end if;
    elsif result_row.status <> 'active' or result_row.config_version <> 1 then
      raise exception 'Non-overdue session was modified';
    end if;
  end loop;
end;
$$;
rollback;
