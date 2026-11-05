-- LOCK database only. Existing credentials, usernames and entitlements are retained.
begin;
alter table public.lock_access_licenses
  add column if not exists next_validation_attempt_at timestamptz,
  add column if not exists last_good_validation_at timestamptz,
  add column if not exists validation_failures integer not null default 0;
update public.lock_access_licenses set last_good_validation_at=coalesce(last_validated_at,created_at)
  where status='active' and last_good_validation_at is null;

create or replace function public.reset_lock_validation_after_transfer() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.revision is distinct from old.revision then
    new.next_validation_attempt_at:=null;
    new.validation_failures:=0;
    -- Keep the last successful verification as the outage grace anchor, while
    -- the existing transfer function clears last_validated_at to force sync.
  end if;
  return new;
end $$;
drop trigger if exists reset_lock_validation_after_transfer on public.lock_access_licenses;
create trigger reset_lock_validation_after_transfer before update of revision on public.lock_access_licenses
  for each row execute function public.reset_lock_validation_after_transfer();

-- Durable fence: a delayed activation using an admin-reset claim may NEVER finish.
create table if not exists public.lock_activation_reset_fences (
  license_id uuid not null,
  credential_hash text not null check (credential_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz not null default now(),
  actor text not null,
  primary key (license_id, credential_hash)
);
alter table public.lock_activation_reset_fences enable row level security;
revoke all on public.lock_activation_reset_fences from public,anon,authenticated;
grant all on public.lock_activation_reset_fences to service_role;

create or replace function public.fence_incomplete_lock_activation(p_license uuid,p_hash text,p_actor text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_license is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or coalesce(p_actor,'')='' then
    raise exception 'license_invalid_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_license::text,0));
  if exists(select 1 from public.lock_access_licenses where id=p_license) then
    raise exception 'license_already_activated';
  end if;
  insert into public.lock_activation_reset_fences values(p_license,p_hash,now(),p_actor) on conflict do nothing;
end $$;

create or replace function public.begin_lock_license_check(p_license uuid,p_sub uuid,p_device uuid,p_revision integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.lock_access_licenses set next_validation_attempt_at=clock_timestamp()+interval '30 seconds'
    where id=p_license and current_sub_id=p_sub and current_device_id=p_device and revision=p_revision and status='active'
      and (next_validation_attempt_at is null or next_validation_attempt_at<=clock_timestamp())
      and (last_validated_at is null or last_validated_at<=clock_timestamp()-interval '30 minutes');
  return found;
end $$;

create or replace function public.fail_lock_license_check(p_license uuid,p_sub uuid,p_device uuid,p_revision integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.lock_access_licenses set
    next_validation_attempt_at=clock_timestamp()+make_interval(secs=>least(900,60*power(2,least(validation_failures,4)))::integer),
    validation_failures=least(validation_failures+1,10)
    where id=p_license and current_sub_id=p_sub and current_device_id=p_device and revision=p_revision and status='active';
end $$;

create or replace function public.finish_lock_license_check(p_license uuid,p_sub uuid,p_device uuid,p_revision integer,p_status text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_status is null or p_status not in ('active','revoked') then raise exception 'license_invalid_input'; end if;
  update public.lock_access_licenses set status=p_status,last_validated_at=clock_timestamp(),
    last_good_validation_at=case when p_status='active' then clock_timestamp() else last_good_validation_at end,
    next_validation_attempt_at=null,validation_failures=0
    where id=p_license and current_sub_id=p_sub and current_device_id=p_device and revision=p_revision and status='active';
  if not found then return false; end if;
  if p_status='revoked' then
    update public.sessions set status='revoked' where device_id=p_device and status in ('active','paused');
  end if;
  return true;
end $$;

create or replace function public.activate_lock_access_license(p_license uuid,p_hash text,p_details jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.lock_access_licenses; d public.devices; s public.subs; sid uuid; did uuid;
begin
  if p_license is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
    or coalesce(p_details->>'username','') !~ '^[a-zA-Z0-9_]{3,20}$'
    or length(coalesce(p_details->>'deviceName','')) not between 1 and 100 then raise exception 'license_invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_license::text,0));
  if exists(select 1 from public.lock_activation_reset_fences where license_id=p_license and credential_hash=p_hash) then
    raise exception 'license_claim_reset';
  end if;
  select * into l from public.lock_access_licenses where id=p_license for update;
  if found then
    select * into d from public.devices where id=l.current_device_id;
    select * into s from public.subs where id=l.current_sub_id;
    if l.source <> 'code' or l.status <> 'active' or l.activation_hash is distinct from p_hash
      or d.device_secret_hash is distinct from p_hash or d.access_revoked_at is not null or s.status <> 'active'
      then raise exception 'license_bound_elsewhere'; end if;
    return jsonb_build_object('deviceId',d.id,'subId',s.id,'username',s.username,'status','active');
  end if;
  select * into d from public.devices where device_secret_hash=p_hash or
    (p_details->>'hardwareIdHash' is not null and hardware_id_hash=p_details->>'hardwareIdHash') for update;
  if found then
    select * into s from public.subs where id=d.sub_id for update;
    if d.device_secret_hash is distinct from p_hash or d.access_revoked_at is not null or d.transfer_protected
      or s.status <> 'invited' or s.access_transfer_id is not null or s.access_license_id is not null
      then raise exception 'license_existing_device'; end if;
    sid:=s.id; did:=d.id;
  else
    insert into public.subs(label,username,status)
      values(left(coalesce(nullif(p_details->>'displayName',''),p_details->>'username'),100),p_details->>'username','invited') returning id into sid;
    insert into public.devices(sub_id,device_name,platform,device_secret_hash,device_secret_created_at,hardware_id_hash,
      timezone,device_manufacturer,device_model,android_release,android_sdk_int)
      values(sid,p_details->>'deviceName','android',p_hash,now(),p_details->>'hardwareIdHash',p_details->>'timezone',
        p_details->>'deviceManufacturer',p_details->>'deviceModel',p_details->>'androidRelease',(p_details->>'androidSdkInt')::integer) returning id into did;
  end if;
  insert into public.lock_access_licenses(id,current_sub_id,current_device_id,source,activation_hash)
    values(p_license,sid,did,'code',p_hash);
  update public.subs set access_license_id=p_license,status='active' where id=sid;
  return jsonb_build_object('deviceId',did,'subId',sid,'username',(select username from public.subs where id=sid),'status','active');
end $$;

-- Called only after the backend reproduces the generated username from the bearer
-- secret. Never guess from a regex or rename customized/legacy/transferred accounts.
create or replace function public.repair_lock_generated_label(p_device uuid,p_username text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.subs s set label=d.device_name
  from public.lock_access_licenses l join public.devices d on d.id=l.current_device_id
  where s.id=l.current_sub_id and d.id=p_device and l.source='code' and l.revision=0
    and s.username=p_username and s.label=s.username and d.access_revoked_at is null;
end $$;

revoke all on function public.reset_lock_validation_after_transfer(),public.repair_lock_generated_label(uuid,text),public.fence_incomplete_lock_activation(uuid,text,text),
 public.begin_lock_license_check(uuid,uuid,uuid,integer),public.fail_lock_license_check(uuid,uuid,uuid,integer),
 public.finish_lock_license_check(uuid,uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.repair_lock_generated_label(uuid,text),public.fence_incomplete_lock_activation(uuid,text,text),
 public.begin_lock_license_check(uuid,uuid,uuid,integer),public.fail_lock_license_check(uuid,uuid,uuid,integer),
 public.finish_lock_license_check(uuid,uuid,uuid,integer,text) to service_role;
commit;
