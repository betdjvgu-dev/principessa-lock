-- Staging only, after phase-session-completion-20260920.sql. Fixtures roll back.
begin;
do $$
declare
  device_uuid uuid := gen_random_uuid();
  request_uuid uuid;
  session_uuid uuid;
  scenario integer;
  changed integer;
  result_row public.sessions%rowtype;
  end_time timestamptz;
  initial_status text;
begin
  if has_function_privilege('anon', 'public.complete_elapsed_sessions(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.complete_elapsed_sessions(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.complete_elapsed_sessions(uuid)', 'execute') then
    raise exception 'Incorrect completion RPC privileges';
  end if;
  insert into public.devices (id, device_name) values (device_uuid, 'completion-test-' || device_uuid);
  for scenario in 0..5 loop
    request_uuid := gen_random_uuid();
    session_uuid := gen_random_uuid();
    end_time := case scenario
      when 0 then statement_timestamp() - interval '1 hour'
      when 1 then statement_timestamp()
      when 2 then statement_timestamp() + interval '1 day'
      else statement_timestamp() - interval '1 hour'
    end;
    initial_status := case scenario when 4 then 'revoked' when 5 then 'completed' else 'active' end;
    insert into public.session_requests (id, device_name, requested_days, daily_limit_minutes)
      values (request_uuid, 'completion-test-' || request_uuid, 1, 30);
    insert into public.sessions (id, request_id, device_id, session_days, daily_limit_minutes, starts_at, ends_at, status, paused_at)
      values (session_uuid, request_uuid, device_uuid, 1, 30, statement_timestamp() - interval '2 days', end_time, initial_status,
        case when scenario = 3 then statement_timestamp() - interval '2 hours' else null end);
    insert into public.device_remote_actions (session_id, device_id, action_type)
      values (session_uuid, device_uuid, 'force_lock');
    changed := public.complete_elapsed_sessions(session_uuid);
    select * into strict result_row from public.sessions where id = session_uuid;
    if scenario in (0, 1) then
      if changed <> 1 or result_row.status <> 'completed' or result_row.config_version <> 2 or result_row.ends_at <> end_time then
        raise exception 'Elapsed session did not complete correctly: %', scenario;
      end if;
      if exists (select 1 from public.device_remote_actions where session_id = session_uuid and status = 'pending') then
        raise exception 'Completed session retains pending actions';
      end if;
      if public.complete_elapsed_sessions(session_uuid) <> 0 then
        raise exception 'Completion must be idempotent';
      end if;
    elsif changed <> 0 or result_row.status <> initial_status or result_row.config_version <> 1 then
      raise exception 'Future, paused or terminal session changed: %', scenario;
    end if;
  end loop;
end;
$$;
rollback;
