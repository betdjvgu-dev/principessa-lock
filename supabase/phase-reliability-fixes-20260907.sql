-- Apply before deploying the matching backend. No history is removed.
begin;

create index if not exists device_heartbeats_latest_status_idx
  on public.device_heartbeats ((coalesce(device_id, session_id, id)), received_at desc, id desc);

create or replace view public.latest_device_heartbeats
with (security_invoker = true) as
select distinct on (coalesce(device_id, session_id, id))
  coalesce(device_id, session_id, id) as status_key, h.*
from public.device_heartbeats h
order by coalesce(device_id, session_id, id), received_at desc, id desc;

revoke all on public.latest_device_heartbeats from public, anon, authenticated;
grant select on public.latest_device_heartbeats to service_role;

alter table public.devices
  add column if not exists pending_protection_alert jsonb,
  add column if not exists last_protection_alert_attempt_at timestamptz;

commit;
