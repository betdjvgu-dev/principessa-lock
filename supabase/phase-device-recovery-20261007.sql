-- Apply to Principessa Lock only. Existing accounts, sessions and history are retained.
begin;
create table if not exists public.device_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id),
  sub_id uuid not null references public.subs(id),
  candidate_secret_hash text not null check (candidate_secret_hash ~ '^[0-9a-f]{64}$'),
  previous_secret_hash text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  decided_at timestamptz,
  decided_by text
);
create unique index if not exists device_recovery_one_pending on public.device_recovery_requests(device_id) where status='pending';
create index if not exists device_recovery_created on public.device_recovery_requests(created_at desc);
alter table public.device_recovery_requests enable row level security;
revoke all on public.device_recovery_requests from anon, authenticated;
grant all on public.device_recovery_requests to service_role;

create or replace function public.request_device_recovery(p_hardware text, p_username text, p_secret_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; s public.subs%rowtype; r public.device_recovery_requests%rowtype; sid uuid;
begin
  if p_hardware !~ '^[0-9a-f]{64}$' or p_secret_hash !~ '^[0-9a-f]{64}$' or p_username is null then
    raise exception 'recovery_invalid';
  end if;
  select * into d from public.devices where hardware_id_hash=p_hardware;
  if not found or d.access_revoked_at is not null then raise exception 'recovery_unavailable'; end if;
  select * into s from public.subs where id=d.sub_id for update;
  if not found or s.status<>'active' or lower(s.username)<>lower(p_username) then raise exception 'recovery_unavailable'; end if;
  select * into d from public.devices where hardware_id_hash=p_hardware for update;
  if d.sub_id is distinct from s.id or d.access_revoked_at is not null then raise exception 'recovery_unavailable'; end if;
  -- Only the candidate approved by the admin may retrieve this identity. Replays after
  -- another rotation/transfer cannot retrieve credentials or account data.
  if d.device_secret_hash=p_secret_hash and exists(select 1 from public.device_recovery_requests
    where device_id=d.id and candidate_secret_hash=p_secret_hash and status='approved') then
    select id into sid from public.sessions where device_id=d.id and status in ('active','paused')
      order by starts_at desc limit 1;
    return jsonb_build_object('status','approved','deviceId',d.id,'username',s.username,'deviceName',d.device_name,'sessionId',sid);
  end if;
  update public.device_recovery_requests set status='expired' where device_id=d.id and status='pending' and expires_at<=clock_timestamp();
  select * into r from public.device_recovery_requests where device_id=d.id and status='pending';
  if found then
    if r.candidate_secret_hash<>p_secret_hash then raise exception 'recovery_pending'; end if;
    return jsonb_build_object('status','pending');
  end if;
  if exists(select 1 from public.device_recovery_requests where device_id=d.id and candidate_secret_hash=p_secret_hash and status='rejected') then
    raise exception 'recovery_rejected';
  end if;
  if exists(select 1 from public.devices where device_secret_hash=p_secret_hash) then raise exception 'recovery_invalid'; end if;
  insert into public.device_recovery_requests(device_id,sub_id,candidate_secret_hash,previous_secret_hash)
    values(d.id,s.id,p_secret_hash,d.device_secret_hash);
  return jsonb_build_object('status','pending');
end $$;

create or replace function public.decide_device_recovery(p_id uuid, p_approve boolean, p_actor text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.device_recovery_requests%rowtype; d public.devices%rowtype; s public.subs%rowtype;
begin
  select * into r from public.device_recovery_requests where id=p_id;
  if not found then raise exception 'recovery_unavailable'; end if;
  -- Account first, matching transfer/activation lock order.
  select * into s from public.subs where id=r.sub_id for update;
  select * into d from public.devices where id=r.device_id for update;
  select * into r from public.device_recovery_requests where id=p_id for update;
  if r.status<>'pending' or r.expires_at<=clock_timestamp() then raise exception 'recovery_not_pending'; end if;
  if d.access_revoked_at is not null or d.sub_id<>r.sub_id or s.status<>'active'
    or d.device_secret_hash is distinct from r.previous_secret_hash then raise exception 'recovery_unavailable'; end if;
  update public.device_recovery_requests set status=case when p_approve then 'approved' else 'rejected' end,
    decided_at=clock_timestamp(),decided_by=p_actor where id=p_id;
  if p_approve then
    update public.devices set device_secret_hash=r.candidate_secret_hash,
      device_secret_created_at=coalesce(device_secret_created_at,clock_timestamp()),
      device_secret_rotated_at=clock_timestamp() where id=d.id;
  end if;
end $$;
-- Transferred-to devices may recover only through an exact admin-approved rotation.
-- Revoked source devices and removal of transfer protection remain forbidden.
create or replace function public.guard_revoked_device() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if old.transfer_protected and (not new.transfer_protected or
    (new.device_secret_hash is not null and new.device_secret_hash is distinct from old.device_secret_hash
      and not exists(select 1 from public.device_recovery_requests r where r.device_id=old.id
        and r.sub_id=old.sub_id and new.sub_id=old.sub_id and r.status='approved'
        and r.previous_secret_hash is not distinct from old.device_secret_hash
        and r.candidate_secret_hash=new.device_secret_hash))) then
    raise exception 'transfer_credential_required';
  end if;
  if old.access_revoked_at is not null and (new.device_secret_hash is not null or new.access_revoked_at is null) then
    raise exception 'transfer_source_revoked';
  end if;
  return new;
end $$;
revoke all on function public.request_device_recovery(text,text,text),public.decide_device_recovery(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.request_device_recovery(text,text,text),public.decide_device_recovery(uuid,boolean,text) to service_role;
commit;
