-- Apply to LOCK Supabase, after the access-transfer/recovery migrations.
begin;
create table if not exists public.lock_access_licenses (
  id uuid primary key default gen_random_uuid(),
  current_sub_id uuid not null unique references public.subs(id),
  current_device_id uuid not null references public.devices(id),
  source text not null check (source in ('legacy','code')),
  legacy_sub_id uuid unique references public.subs(id),
  activation_hash text,
  status text not null default 'active' check (status in ('active','revoked')),
  revision integer not null default 0,
  last_validated_at timestamptz,
  created_at timestamptz not null default now(),
  check ((source='legacy' and legacy_sub_id is not null) or (source='code' and activation_hash is not null and activation_hash ~ '^[a-f0-9]{64}$'))
);
alter table public.subs add column if not exists access_license_id uuid references public.lock_access_licenses(id);
create table if not exists public.lock_legacy_access_candidates (sub_id uuid primary key references public.subs(id));
create table if not exists public.lock_license_migrations (name text primary key, applied_at timestamptz not null default now());
-- Capture eligibility once, not every time the migration is reapplied. Pending users
-- still require the original manual approval before any entitlement is created.
do $$ begin
  if not exists(select 1 from public.lock_license_migrations where name='legacy-snapshot') then
    insert into public.lock_legacy_access_candidates select id from public.subs where status in ('active','invited');
    insert into public.lock_license_migrations(name) values('legacy-snapshot');
  end if;
end $$;

create or replace function public.attach_legacy_lock_license(p_sub uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare d uuid; l uuid;
begin
  perform 1 from public.subs where id=p_sub and status='active' and access_license_id is null for update;
  if not found or not exists(select 1 from public.lock_legacy_access_candidates where sub_id=p_sub) then return; end if;
  if (select count(*) from public.devices where sub_id=p_sub and access_revoked_at is null and device_secret_hash is not null) > 1 then
    raise exception 'license_ambiguous_legacy_devices: %',p_sub;
  end if;
  select id into d from public.devices where sub_id=p_sub and access_revoked_at is null and device_secret_hash is not null;
  if d is null then return; end if;
  insert into public.lock_access_licenses(current_sub_id,current_device_id,source,legacy_sub_id)
    values(p_sub,d,'legacy',p_sub) on conflict(current_sub_id) do nothing;
  select id into l from public.lock_access_licenses where current_sub_id=p_sub;
  update public.subs set access_license_id=l where id=p_sub;
end $$;
do $$ declare r record; begin
  for r in select sub_id from public.lock_legacy_access_candidates loop perform public.attach_legacy_lock_license(r.sub_id); end loop;
end $$;
create or replace function public.attach_approved_legacy_lock_license() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$ begin
  if new.status='active' and old.status='invited' and new.access_license_id is null and new.access_transfer_id is null then
    -- Explicit admin approval remains valid during rollout, including requests made
    -- after the snapshot. Unapproved registrations never obtain an entitlement.
    insert into public.lock_legacy_access_candidates values(new.id) on conflict do nothing;
    perform public.attach_legacy_lock_license(new.id);
  end if;
  return new;
end $$;
drop trigger if exists attach_approved_legacy_lock_license on public.subs;
create trigger attach_approved_legacy_lock_license after update of status on public.subs for each row execute function public.attach_approved_legacy_lock_license();

-- Executes inside the existing transfer decision transaction. No client-side rebind.
create or replace function public.transfer_lock_access_license() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.lock_access_licenses;
begin
  if new.status='approved' and old.status is distinct from new.status then
    perform public.attach_legacy_lock_license(new.source_sub_id);
    select * into l from public.lock_access_licenses where current_sub_id=new.source_sub_id for update;
    if not found or l.status <> 'active' then raise exception 'license_source_unavailable'; end if;
    update public.lock_access_licenses set current_sub_id=new.target_sub_id,current_device_id=new.target_device_id,
      revision=revision+1,last_validated_at=null where id=l.id;
    update public.subs set access_license_id=l.id where id=new.target_sub_id;
  end if;
  return new;
end $$;
drop trigger if exists transfer_lock_access_license on public.access_transfers;
create trigger transfer_lock_access_license after update of status on public.access_transfers for each row execute function public.transfer_lock_access_license();

create or replace function public.activate_lock_access_license(p_license uuid,p_hash text,p_details jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.lock_access_licenses; d public.devices; s public.subs; sid uuid; did uuid;
begin
  if p_license is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
    or coalesce(p_details->>'username','') !~ '^[a-zA-Z0-9_]{3,20}$'
    or length(coalesce(p_details->>'deviceName','')) not between 1 and 100 then raise exception 'license_invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_license::text,0));
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
    insert into public.subs(label,username,status) values(p_details->>'username',p_details->>'username','invited') returning id into sid;
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

alter table public.lock_access_licenses enable row level security;
alter table public.lock_legacy_access_candidates enable row level security;
alter table public.lock_license_migrations enable row level security;
revoke all on public.lock_access_licenses,public.lock_legacy_access_candidates,public.lock_license_migrations from public,anon,authenticated;
grant all on public.lock_access_licenses,public.lock_legacy_access_candidates,public.lock_license_migrations to service_role;
revoke all on function public.attach_legacy_lock_license(uuid),public.attach_approved_legacy_lock_license(),
  public.transfer_lock_access_license(),public.activate_lock_access_license(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.attach_legacy_lock_license(uuid),public.activate_lock_access_license(uuid,text,jsonb) to service_role;
commit;
