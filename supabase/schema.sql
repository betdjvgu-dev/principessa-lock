create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.session_requests (
  id uuid primary key default gen_random_uuid(),
  device_name text not null,
  requested_days integer not null,
  daily_limit_minutes integer not null,
  forced_sleep_enabled boolean not null default false,
  status text not null default 'pending',
  activation_code_hash text,
  activation_code_expires_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'activated', 'expired')),
  constraint session_requests_requested_days_check
    check (requested_days between 1 and 30),
  constraint session_requests_daily_limit_minutes_check
    check (daily_limit_minutes between 5 and 90)
);

create unique index if not exists session_requests_activation_code_hash_key
  on public.session_requests (activation_code_hash)
  where activation_code_hash is not null;

create index if not exists session_requests_status_created_at_idx
  on public.session_requests (status, created_at desc);

create table if not exists public.subs (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  status text not null default 'invited',
  pairing_code_hash text,
  pairing_code_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subs_status_check check (status in ('invited', 'active', 'archived'))
);

alter table public.subs
  add column if not exists pending_session_days integer;

alter table public.subs
  add column if not exists pending_daily_limit_minutes integer;

alter table public.subs
  add column if not exists pending_forced_sleep_enabled boolean;

create unique index if not exists subs_pairing_code_hash_key
  on public.subs (pairing_code_hash)
  where pairing_code_hash is not null;

create index if not exists subs_status_created_at_idx
  on public.subs (status, created_at desc);

drop trigger if exists set_subs_updated_at on public.subs;
create trigger set_subs_updated_at
before update on public.subs
for each row
execute function public.set_updated_at();

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  device_name text not null,
  device_secret_hash text,
  device_secret_created_at timestamptz,
  device_secret_rotated_at timestamptz,
  platform text not null default 'android',
  timezone text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.devices
  add column if not exists device_secret_hash text;

alter table public.devices
  add column if not exists device_secret_created_at timestamptz;

alter table public.devices
  add column if not exists device_secret_rotated_at timestamptz;

alter table public.devices
  add column if not exists fcm_token text;

alter table public.devices
  add column if not exists sub_id uuid references public.subs(id) on delete cascade;

create unique index if not exists devices_device_secret_hash_key
  on public.devices (device_secret_hash)
  where device_secret_hash is not null;

create index if not exists devices_sub_id_idx
  on public.devices (sub_id);

alter table public.session_requests
  add column if not exists sub_id uuid references public.subs(id) on delete cascade;

alter table public.session_requests
  add column if not exists device_id uuid references public.devices(id) on delete cascade;

alter table public.session_requests
  add column if not exists payment_note text;

create index if not exists session_requests_sub_id_idx
  on public.session_requests (sub_id, created_at desc);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.session_requests(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  session_days integer not null,
  daily_limit_minutes integer not null,
  forced_sleep_enabled boolean not null default false,
  sleep_start_time text not null default '23:00',
  sleep_end_time text not null default '07:00',
  timezone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'active',
  config_version integer not null default 1,
  activated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sessions_status_check
    check (status in ('active', 'completed', 'revoked')),
  constraint sessions_session_days_check
    check (session_days between 1 and 30),
  constraint sessions_daily_limit_minutes_check
    check (daily_limit_minutes between 5 and 90),
  constraint sessions_request_id_unique
    unique (request_id)
);

create index if not exists sessions_device_id_idx
  on public.sessions (device_id, created_at desc);

create index if not exists sessions_status_idx
  on public.sessions (status, created_at desc);

create index if not exists sessions_status_updated_at_idx
  on public.sessions (status, updated_at desc);

alter table public.sessions
  add column if not exists sleep_start_time text not null default '23:00';

alter table public.sessions
  add column if not exists sleep_end_time text not null default '07:00';

alter table public.sessions
  add column if not exists updated_at timestamptz not null default now();

alter table public.sessions
  add column if not exists config_version integer not null default 1;

alter table public.sessions
  add column if not exists sub_id uuid references public.subs(id) on delete cascade;

create index if not exists sessions_sub_id_idx
  on public.sessions (sub_id, created_at desc);

create table if not exists public.session_daily_usage (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  local_date date not null,
  used_minutes integer not null default 0,
  limit_minutes integer not null,
  reset_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_daily_usage_used_minutes_check
    check (used_minutes >= 0),
  constraint session_daily_usage_limit_minutes_check
    check (limit_minutes between 5 and 90),
  constraint session_daily_usage_session_id_local_date_key
    unique (session_id, local_date)
);

create index if not exists session_daily_usage_session_id_idx
  on public.session_daily_usage (session_id, local_date desc);

create table if not exists public.device_heartbeats (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references public.devices(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  received_at timestamptz not null default now(),
  device_name text,
  platform text not null default 'android',
  timezone text,
  app_version text,
  session_status text,
  protection_state text,
  protection_healthy boolean,
  protection_health_level text,
  protection_health_status text,
  protection_broken_reasons jsonb not null default '[]'::jsonb,
  service_running boolean,
  foreground_service_running boolean,
  active_session_present boolean,
  accessibility_granted boolean,
  accessibility_running boolean,
  forced_sleep_enabled boolean,
  forced_sleep_ready boolean,
  inside_sleep_window boolean,
  usage_access_granted boolean,
  device_admin_granted boolean,
  blocking_required boolean,
  blocking_active boolean,
  blocking_method text,
  overlay_permission_granted boolean,
  overlay_ready boolean,
  overlay_active boolean,
  used_minutes integer,
  daily_limit_minutes integer,
  remaining_minutes integer,
  limit_reached boolean,
  battery_optimization_ignored boolean,
  last_accessibility_event_at timestamptz,
  last_protection_tick_at timestamptz,
  last_remote_action_check_at timestamptz,
  last_recovery_attempt_at timestamptz,
  last_recovery_reason text,
  last_protection_check_at timestamptz,
  last_session_sync_at timestamptz,
  last_usage_refresh_at timestamptz,
  network_connected boolean,
  polling_interval_ms integer,
  polling_mode text,
  remote_action_queue_length integer,
  local_date date,
  payload jsonb not null default '{}'::jsonb
);

alter table if exists public.device_heartbeats
  add column if not exists protection_healthy boolean;

alter table if exists public.device_heartbeats
  add column if not exists protection_health_level text;

alter table if exists public.device_heartbeats
  add column if not exists protection_health_status text;

alter table if exists public.device_heartbeats
  add column if not exists protection_broken_reasons jsonb not null default '[]'::jsonb;

alter table if exists public.device_heartbeats
  add column if not exists service_running boolean;

alter table if exists public.device_heartbeats
  add column if not exists foreground_service_running boolean;

alter table if exists public.device_heartbeats
  add column if not exists active_session_present boolean;

alter table if exists public.device_heartbeats
  add column if not exists accessibility_granted boolean;

alter table if exists public.device_heartbeats
  add column if not exists accessibility_running boolean;

alter table if exists public.device_heartbeats
  add column if not exists forced_sleep_ready boolean;

alter table if exists public.device_heartbeats
  add column if not exists blocking_required boolean;

alter table if exists public.device_heartbeats
  add column if not exists last_accessibility_event_at timestamptz;

alter table if exists public.device_heartbeats
  add column if not exists last_recovery_attempt_at timestamptz;

alter table if exists public.device_heartbeats
  add column if not exists last_recovery_reason text;

alter table if exists public.device_heartbeats
  add column if not exists last_protection_check_at timestamptz;

alter table if exists public.device_heartbeats
  add column if not exists last_protection_tick_at timestamptz;

alter table if exists public.device_heartbeats
  add column if not exists last_remote_action_check_at timestamptz;

alter table if exists public.device_heartbeats
  add column if not exists blocking_method text;

alter table if exists public.device_heartbeats
  add column if not exists overlay_permission_granted boolean;

alter table if exists public.device_heartbeats
  add column if not exists overlay_ready boolean;

alter table if exists public.device_heartbeats
  add column if not exists overlay_active boolean;

alter table if exists public.device_heartbeats
  add column if not exists last_session_sync_at timestamptz;

alter table if exists public.device_heartbeats
  add column if not exists network_connected boolean;

alter table if exists public.device_heartbeats
  add column if not exists polling_interval_ms integer;

alter table if exists public.device_heartbeats
  add column if not exists polling_mode text;

alter table if exists public.device_heartbeats
  add column if not exists remote_action_queue_length integer;

alter table if exists public.device_heartbeats
  add column if not exists sub_id uuid references public.subs(id) on delete set null;

alter table if exists public.device_heartbeats
  add column if not exists root_detected boolean;

alter table if exists public.device_heartbeats
  add column if not exists emulator_detected boolean;

alter table if exists public.device_heartbeats
  add column if not exists debugger_attached boolean;

create index if not exists device_heartbeats_received_at_idx
  on public.device_heartbeats (received_at desc);

create index if not exists device_heartbeats_session_id_received_at_idx
  on public.device_heartbeats (session_id, received_at desc);

create index if not exists device_heartbeats_device_id_received_at_idx
  on public.device_heartbeats (device_id, received_at desc);

create index if not exists device_heartbeats_sub_id_received_at_idx
  on public.device_heartbeats (sub_id, received_at desc);

create table if not exists public.device_remote_actions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  sub_id uuid references public.subs(id) on delete set null,
  action_type text not null,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  error_message text,
  constraint device_remote_actions_status_check
    check (status in ('pending', 'completed', 'failed', 'cancelled')),
  constraint device_remote_actions_action_type_check
    check (action_type in ('force_lock', 'clear_local_usage', 'sync_config'))
);

alter table public.device_remote_actions
  add column if not exists sub_id uuid references public.subs(id) on delete set null;

alter table public.device_remote_actions
  drop constraint if exists device_remote_actions_action_type_check;

alter table public.device_remote_actions
  add constraint device_remote_actions_action_type_check
  check (action_type in ('force_lock', 'clear_local_usage', 'sync_config', 'capture_screenshot'));

create index if not exists device_remote_actions_session_status_requested_idx
  on public.device_remote_actions (session_id, status, requested_at asc);

create index if not exists device_remote_actions_device_status_requested_idx
  on public.device_remote_actions (device_id, status, requested_at asc);

create index if not exists device_remote_actions_sub_id_requested_idx
  on public.device_remote_actions (sub_id, status, requested_at asc);

drop trigger if exists set_session_requests_updated_at on public.session_requests;
create trigger set_session_requests_updated_at
before update on public.session_requests
for each row
execute function public.set_updated_at();

drop trigger if exists set_session_daily_usage_updated_at on public.session_daily_usage;
create trigger set_session_daily_usage_updated_at
before update on public.session_daily_usage
for each row
execute function public.set_updated_at();

drop trigger if exists set_sessions_updated_at on public.sessions;
create trigger set_sessions_updated_at
before update on public.sessions
for each row
execute function public.set_updated_at();
