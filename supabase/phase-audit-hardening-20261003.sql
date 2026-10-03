-- Apply after existing schema/migrations, before deploying the matching backend.
begin;

create table if not exists public.admin_rls_identities (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);
alter table public.admin_rls_identities enable row level security;
revoke all on public.admin_rls_identities from public, anon, authenticated;
grant all on public.admin_rls_identities to service_role;

create or replace function public.is_lock_admin() returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists(select 1 from public.admin_rls_identities where user_id = auth.uid());
$$;
revoke all on function public.is_lock_admin() from public, anon;
grant execute on function public.is_lock_admin() to authenticated, service_role;

-- Only the server calls this after verifying ADMIN_EMAIL. No client can nominate an admin.
create or replace function public.set_lock_realtime_admin(p_user_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform pg_advisory_xact_lock(734172);
  delete from public.admin_rls_identities where user_id <> p_user_id;
  insert into public.admin_rls_identities(user_id) values(p_user_id) on conflict do nothing;
end;
$$;
revoke all on function public.set_lock_realtime_admin(uuid) from public, anon, authenticated;
grant execute on function public.set_lock_realtime_admin(uuid) to service_role;

do $$
declare t text; p record;
begin
  foreach t in array array['subs','devices','session_requests','sessions','session_daily_usage',
    'session_messages','app_unlock_requests','device_heartbeats','device_remote_actions',
    'admin_push_tokens','app_releases','crash_reports','access_transfers','access_transfer_events'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    if t = any(array['subs','sessions','session_requests','session_messages',
        'app_unlock_requests','device_heartbeats','device_remote_actions']) then
      execute format('grant select on public.%I to authenticated', t);
      execute format('create policy lock_admin_read on public.%I for select to authenticated using ((select public.is_lock_admin()))', t);
    end if;
  end loop;
end $$;

alter table public.session_requests add column if not exists gallery_access_consented boolean not null default false;
alter table public.sessions add column if not exists gallery_access_consented boolean not null default false;
-- Existing enabled flags are not proof of user consent: do not manufacture legacy consent.
update public.sessions set gallery_access_enabled=false, config_version=config_version+1
  where not gallery_access_consented and gallery_access_enabled;
update public.session_requests set gallery_access_enabled=false where not gallery_access_consented and gallery_access_enabled;

create or replace function public.guard_gallery_consent() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op='UPDATE' and new.gallery_access_consented is distinct from old.gallery_access_consented then
    raise exception 'gallery_consent_immutable';
  end if;
  if new.gallery_access_enabled and not new.gallery_access_consented then
    raise exception 'gallery_user_consent_required';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_gallery_consent on public.session_requests;
create trigger guard_gallery_consent before insert or update on public.session_requests
for each row execute function public.guard_gallery_consent();
drop trigger if exists guard_gallery_consent on public.sessions;
create trigger guard_gallery_consent before insert or update on public.sessions
for each row execute function public.guard_gallery_consent();

alter table public.sessions add column if not exists total_paused_ms bigint not null default 0;
create or replace function public.account_session_pause() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.paused_at is not null and new.paused_at is null then
    new.total_paused_ms := old.total_paused_ms + greatest(0, floor(extract(epoch from (now()-old.paused_at))*1000)::bigint);
  else
    new.total_paused_ms := old.total_paused_ms;
  end if;
  return new;
end;
$$;
drop trigger if exists account_session_pause on public.sessions;
create trigger account_session_pause before update on public.sessions
for each row execute function public.account_session_pause();

create or replace function public.activate_device_session(p_device_id uuid, p_request_id uuid, p_timezone text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.session_requests; s public.sessions; d public.devices; started timestamptz := now();
begin
  select * into d from public.devices where id=p_device_id for update;
  if not found or d.access_revoked_at is not null or not exists(
    select 1 from public.subs where id=d.sub_id and status='active') then
    raise exception 'activation_unavailable';
  end if;
  select * into r from public.session_requests where id=p_request_id and device_id=p_device_id for update;
  if not found then raise exception 'activation_unavailable'; end if;
  select * into s from public.sessions where request_id=r.id and device_id=p_device_id;
  if found then
    if s.status <> 'active' or (s.paused_at is null and s.ends_at<=started) then
      raise exception 'activation_terminal';
    end if;
    update public.session_requests set status='activated',activated_at=s.activated_at where id=r.id;
    return jsonb_build_object('created',false,'session',to_jsonb(s));
  end if;
  if r.status <> 'approved' then raise exception 'activation_unavailable'; end if;
  if r.activation_code_expires_at is null or r.activation_code_expires_at<=started then
    raise exception 'activation_expired';
  end if;
  insert into public.sessions(request_id,device_id,sub_id,session_days,daily_limit_minutes,
    screen_time_enabled,always_allowed_package,forced_sleep_enabled,gallery_access_enabled,
    gallery_access_consented,starts_at,ends_at,activated_at,timezone,status,price_usd)
  values(r.id,d.id,r.sub_id,r.requested_days,r.daily_limit_minutes,r.screen_time_enabled,
    r.always_allowed_package,r.forced_sleep_enabled,r.gallery_access_enabled,r.gallery_access_consented,
    started,started+make_interval(days=>r.requested_days),started,coalesce(p_timezone,d.timezone),'active',0)
  returning * into s;
  update public.sessions set status='revoked',config_version=config_version+1
    where device_id=d.id and status='active' and id<>s.id;
  update public.session_requests set status='activated',activated_at=started where id=r.id;
  return jsonb_build_object('created',true,'session',to_jsonb(s));
end;
$$;
revoke all on function public.activate_device_session(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.activate_device_session(uuid,uuid,text) to service_role;

alter table public.admin_push_tokens drop constraint if exists admin_push_tokens_pkey;
create unique index if not exists admin_push_tokens_token_key on public.admin_push_tokens(fcm_token);
alter table public.admin_push_tokens add primary key(admin_user_id,fcm_token);
-- Tokens written before RLS was closed are untrusted. Admin apps re-register on login.
delete from public.admin_push_tokens where not exists(select 1 from public.admin_rls_identities);

create or replace function public.prune_lock_operational_data() returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if to_regclass('public.device_heartbeats') is not null then
    delete from public.device_heartbeats h where h.received_at < now()-interval '30 days'
      and exists(select 1 from public.device_heartbeats n where n.device_id is not distinct from h.device_id
        and n.session_id is not distinct from h.session_id and (n.received_at,n.id)>(h.received_at,h.id));
  end if;
  if to_regclass('public.device_remote_actions') is not null then
    update public.device_remote_actions set result_payload=result_payload-'photosBase64'-'screenshotBase64'
      where action_type in ('capture_gallery','capture_screenshot')
      and coalesce(completed_at,failed_at,requested_at)<now()-interval '7 days'
      and (result_payload ? 'photosBase64' or result_payload ? 'screenshotBase64');
  end if;
end;
$$;
revoke all on function public.prune_lock_operational_data() from public, anon, authenticated;
grant execute on function public.prune_lock_operational_data() to service_role;
do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('lock-operational-retention','25 3 * * *','select public.prune_lock_operational_data()');
  end if;
end $$;

commit;
