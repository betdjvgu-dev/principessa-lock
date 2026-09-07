-- Apply before deploying the desktop audit backend changes. No rows are removed.
begin;

create index if not exists device_heartbeats_latest_session_idx
  on public.device_heartbeats (session_id, received_at desc, id desc)
  where session_id is not null;

create or replace view public.latest_session_heartbeats
with (security_invoker = true) as
select distinct on (session_id) h.*
from public.device_heartbeats h
where session_id is not null
order by session_id, received_at desc, id desc;

revoke all on public.latest_session_heartbeats from public, anon, authenticated;
grant select on public.latest_session_heartbeats to service_role;

commit;
