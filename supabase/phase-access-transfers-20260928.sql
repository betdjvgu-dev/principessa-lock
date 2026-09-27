-- Apply to the LOCK database, not the shared Vault/Court database.
-- All mutations below run in one database transaction; only service_role may call them.
begin;

alter table public.devices add column if not exists access_revoked_at timestamptz;
alter table public.devices add column if not exists transfer_protected boolean not null default false;
create table if not exists public.access_transfers (
  id uuid primary key default gen_random_uuid(),
  source_sub_id uuid not null references public.subs(id) on delete restrict,
  source_device_id uuid not null references public.devices(id) on delete restrict,
  target_sub_id uuid references public.subs(id) on delete restrict,
  target_device_id uuid references public.devices(id) on delete restrict,
  code_hash text not null unique check (length(code_hash) = 64),
  status text not null default 'issued' check (status in ('issued','pending','approved','rejected','cancelled','expired')),
  source_username text,
  source_device_name text not null,
  target_username text,
  target_device_name text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  requested_at timestamptz,
  decided_at timestamptz,
  check (target_device_id is null or target_device_id <> source_device_id)
);
create unique index if not exists access_transfers_one_open_source
  on public.access_transfers(source_sub_id) where status in ('issued','pending');
create index if not exists access_transfers_created_idx on public.access_transfers(created_at desc);
alter table public.subs add column if not exists access_transfer_id uuid references public.access_transfers(id) on delete restrict;
create table if not exists public.access_transfer_events (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.access_transfers(id) on delete restrict,
  event_type text not null,
  actor text not null,
  created_at timestamptz not null default now()
);
create index if not exists access_transfer_events_created_idx on public.access_transfer_events(created_at desc);
alter table public.access_transfers enable row level security;
alter table public.access_transfer_events enable row level security;
revoke all on public.access_transfers, public.access_transfer_events from anon, authenticated;
grant all on public.access_transfers, public.access_transfer_events to service_role;

-- Serialize issue, claim, decision and session activation on the source account.
create or replace function public.lock_transfer_source(p_device uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid; s public.subs; d public.devices;
begin
  select sub_id into sid from public.devices where id=p_device;
  if sid is null then raise exception 'transfer_source_unavailable'; end if;
  select * into s from public.subs where id=sid for update;
  select * into d from public.devices where id=p_device for update;
  if s.status <> 'active' or d.access_revoked_at is not null or d.sub_id is distinct from sid then
    raise exception 'transfer_source_unavailable';
  end if;
  if exists(select 1 from public.sessions x join public.devices v on v.id=x.device_id
            where v.sub_id=sid and x.status='active') then
    raise exception 'transfer_active_session';
  end if;
  return sid;
end $$;

create or replace function public.issue_access_transfer(p_device uuid, p_code_hash text, p_actor text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid; t public.access_transfers; result public.access_transfers;
begin
  sid := public.lock_transfer_source(p_device);
  update public.devices set transfer_protected=true where sub_id=sid;
  for t in select * from public.access_transfers where source_sub_id=sid and status in ('issued','pending') for update loop
    if t.status='pending' and t.expires_at > clock_timestamp() then raise exception 'transfer_pending'; end if;
    update public.access_transfers set status=case when expires_at<=clock_timestamp() then 'expired' else 'cancelled' end,
      decided_at=now() where id=t.id;
    if t.target_sub_id is not null then
      update public.subs set status='archived' where id=t.target_sub_id and access_transfer_id=t.id;
      if found then
        update public.devices set fcm_token=null where id=t.target_device_id and sub_id=t.target_sub_id;
      end if;
    end if;
    insert into public.access_transfer_events(transfer_id,event_type,actor)
      values(t.id,case when t.expires_at<=clock_timestamp() then 'expired' else 'cancelled' end,p_actor);
  end loop;
  insert into public.access_transfers(source_sub_id,source_device_id,code_hash,source_username,source_device_name)
    select sid,p_device,p_code_hash,s.username,d.device_name from public.subs s,public.devices d
    where s.id=sid and d.id=p_device returning * into result;
  insert into public.access_transfer_events(transfer_id,event_type,actor) values(result.id,'issued',p_actor);
  return jsonb_build_object('id',result.id,'expiresAt',result.expires_at);
end $$;

create or replace function public.claim_access_transfer(p_code_hash text, p_secret_hash text, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.access_transfers; prior public.access_transfers; existing public.devices;
  sid uuid; did uuid; source_id uuid; recipient_sub_id uuid; recipient_device_id uuid;
begin
  select source_device_id into source_id from public.access_transfers where code_hash=p_code_hash;
  if source_id is null then raise exception 'transfer_invalid_code'; end if;
  -- Lock the same account first as issue/approve to avoid claim-vs-approve deadlocks.
  perform 1 from public.subs where id=(select sub_id from public.devices where id=source_id) for update;
  select * into t from public.access_transfers where code_hash=p_code_hash for update;
  -- A network retry may recover only its own credential, never someone else's claim.
  if t.status in ('pending','approved') and exists(select 1 from public.devices
      where id=t.target_device_id and device_secret_hash=p_secret_hash and access_revoked_at is null) then
    return jsonb_build_object('transferId',t.id,'subId',t.target_sub_id,'deviceId',t.target_device_id,
      'username',t.target_username,'status',case when t.status='approved' then 'active' else 'invited' end);
  end if;
  if t.status <> 'issued' or t.expires_at <= clock_timestamp() then raise exception 'transfer_invalid_code'; end if;
  perform public.lock_transfer_source(source_id);
  if p_secret_hash !~ '^[0-9a-f]{64}$' or coalesce(p_input->>'username','') !~ '^[a-zA-Z0-9_]{3,20}$'
     or length(coalesce(p_input->>'deviceName','')) not between 1 and 100
     or coalesce(p_input->>'hardwareIdHash','') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'transfer_invalid_input';
  end if;
  select * into existing from public.devices where hardware_id_hash=p_input->>'hardwareIdHash';
  if found then
    recipient_sub_id:=existing.sub_id; recipient_device_id:=existing.id;
    -- Only the original credential may retry a never-approved rejected/expired invitation.
    -- Old owners and previously approved accounts can never be recycled this way.
    select a.* into prior from public.access_transfers a join public.subs s on s.access_transfer_id=a.id
      where s.id=existing.sub_id for update of a;
    if not found or not (prior.status in ('rejected','expired','cancelled') or
       (prior.status='pending' and prior.expires_at<=clock_timestamp())) then raise exception 'transfer_existing_device'; end if;
    perform 1 from public.subs where id=recipient_sub_id for update;
    if not found then raise exception 'transfer_existing_device'; end if;
    select * into existing from public.devices where id=recipient_device_id for update;
    if not found then raise exception 'transfer_existing_device'; end if;
    -- Another source's claim may have won while this transaction waited for locks.
    if existing.sub_id is distinct from recipient_sub_id
       or not exists(select 1 from public.subs where id=recipient_sub_id and access_transfer_id=prior.id)
       or prior.target_sub_id is distinct from existing.sub_id or prior.target_device_id is distinct from existing.id
       or existing.device_secret_hash is distinct from p_secret_hash or existing.access_revoked_at is not null
       or existing.sub_id=t.source_sub_id or exists(select 1 from public.sessions where device_id=existing.id)
       or exists(select 1 from public.access_transfers where target_device_id=existing.id and status='approved')
       or exists(select 1 from public.subs where id=existing.sub_id and status='active') then
      raise exception 'transfer_existing_device';
    end if;
    if prior.status='pending' then
      update public.access_transfers set status='expired',decided_at=now() where id=prior.id;
      insert into public.access_transfer_events(transfer_id,event_type,actor) values(prior.id,'expired','device:'||existing.id);
    end if;
    sid:=existing.sub_id; did:=existing.id;
    update public.subs set label=p_input->>'username',username=p_input->>'username',status='invited',access_transfer_id=t.id where id=sid;
    update public.devices set device_name=p_input->>'deviceName',timezone=p_input->>'timezone',fcm_token=null where id=did;
  else
    if exists(select 1 from public.devices where device_secret_hash=p_secret_hash) then raise exception 'transfer_existing_device'; end if;
    insert into public.subs(label,username,access_transfer_id)
      values(p_input->>'username',p_input->>'username',t.id) returning id into sid;
    insert into public.devices(sub_id,device_name,device_secret_hash,device_secret_created_at,hardware_id_hash,transfer_protected,
      timezone,device_manufacturer,device_model,android_release,android_sdk_int)
      values(sid,p_input->>'deviceName',p_secret_hash,now(),p_input->>'hardwareIdHash',true,p_input->>'timezone',
        p_input->>'deviceManufacturer',p_input->>'deviceModel',p_input->>'androidRelease',(p_input->>'androidSdkInt')::integer)
      returning id into did;
  end if;
  if t.expires_at<=clock_timestamp() then raise exception 'transfer_expired'; end if;
  update public.access_transfers set target_sub_id=sid,target_device_id=did,target_username=p_input->>'username',
    target_device_name=p_input->>'deviceName',status='pending',requested_at=now() where id=t.id;
  insert into public.access_transfer_events(transfer_id,event_type,actor) values(t.id,'requested','device:'||did);
  return jsonb_build_object('transferId',t.id,'subId',sid,'deviceId',did,'username',p_input->>'username','status','invited');
end $$;

create or replace function public.decide_access_transfer(p_id uuid, p_approve boolean, p_actor text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.access_transfers; sid uuid;
begin
  select source_sub_id into sid from public.access_transfers where id=p_id;
  if sid is null then raise exception 'transfer_not_found'; end if;
  perform 1 from public.subs where id=sid for update;
  select * into t from public.access_transfers where id=p_id for update;
  if (p_approve and t.status='approved') or (not p_approve and t.status='rejected') then
    return jsonb_build_object('ok',true);
  end if;
  if t.status not in ('issued','pending') then raise exception 'transfer_already_decided'; end if;
  if p_approve then
    if t.status <> 'pending' then raise exception 'transfer_not_claimed'; end if;
    if t.expires_at <= clock_timestamp() then raise exception 'transfer_expired'; end if;
    perform public.lock_transfer_source(t.source_device_id);
    perform 1 from public.subs where id=t.target_sub_id and status='invited' and access_transfer_id=t.id for update;
    if not found then raise exception 'transfer_target_unavailable'; end if;
    perform 1 from public.devices where id=t.target_device_id and sub_id=t.target_sub_id and access_revoked_at is null
      and device_secret_hash is not null for update;
    if not found then raise exception 'transfer_target_unavailable'; end if;
    if t.expires_at <= clock_timestamp() then raise exception 'transfer_expired'; end if;
    update public.access_transfers set status='approved',decided_at=now() where id=t.id;
    update public.subs set status='archived' where id=t.source_sub_id;
    update public.devices set device_secret_hash=null,access_revoked_at=now(),fcm_token=null,
      device_secret_rotated_at=now() where sub_id=t.source_sub_id;
    update public.subs set status='active' where id=t.target_sub_id;
  else
    update public.access_transfers set status='rejected',decided_at=now() where id=t.id;
    update public.subs set status='archived' where id=t.target_sub_id and access_transfer_id=t.id;
    if found then
      update public.devices set fcm_token=null where id=t.target_device_id and sub_id=t.target_sub_id;
    end if;
  end if;
  insert into public.access_transfer_events(transfer_id,event_type,actor)
    values(t.id,case when p_approve then 'approved' else 'rejected' end,p_actor);
  return jsonb_build_object('ok',true);
end $$;

-- Standard registration approval/recovery must not bypass the transfer decision.
create or replace function public.guard_transfer_sub() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.status='active' and new.status is distinct from old.status then
    if new.access_transfer_id is not null and not exists(select 1 from public.access_transfers
      where id=new.access_transfer_id and status='approved') then raise exception 'transfer_requires_approval'; end if;
    if exists(select 1 from public.access_transfers where source_sub_id=new.id and status='approved') then
      raise exception 'transfer_source_revoked';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_transfer_sub on public.subs;
create trigger guard_transfer_sub before update on public.subs for each row execute function public.guard_transfer_sub();

create or replace function public.guard_revoked_device() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if old.transfer_protected and (not new.transfer_protected or
      (new.device_secret_hash is not null and new.device_secret_hash is distinct from old.device_secret_hash)) then
    raise exception 'transfer_credential_required';
  end if;
  if old.access_revoked_at is not null and (new.device_secret_hash is not null or new.access_revoked_at is null) then
    raise exception 'transfer_source_revoked';
  end if;
  return new;
end $$;
drop trigger if exists guard_revoked_device on public.devices;
create trigger guard_revoked_device before update on public.devices for each row execute function public.guard_revoked_device();

-- A concurrent activation must finish before transfer approval, or fail after it.
create or replace function public.guard_transfer_session() returns trigger
language plpgsql set search_path=public,pg_temp as $$
declare sid uuid; state text;
begin
  if new.status='active' then
    select sub_id into sid from public.devices where id=new.device_id;
    if sid is not null then
      select status into state from public.subs where id=sid for update;
      if state <> 'active' then raise exception 'transfer_source_unavailable'; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_transfer_session on public.sessions;
create trigger guard_transfer_session before insert or update of status,device_id on public.sessions
  for each row execute function public.guard_transfer_session();

revoke all on function public.lock_transfer_source(uuid), public.issue_access_transfer(uuid,text,text),
  public.claim_access_transfer(text,text,jsonb),public.decide_access_transfer(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.lock_transfer_source(uuid),public.issue_access_transfer(uuid,text,text),
  public.claim_access_transfer(text,text,jsonb),public.decide_access_transfer(uuid,boolean,text) to service_role;
commit;
