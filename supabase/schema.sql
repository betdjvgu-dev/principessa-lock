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

-- Widened from the original 5-90 so the keyholder can set real terms above 90 minutes when
-- approving a full_discretion request (see validateApproveSessionRequestInput in
-- request-validation.ts) -- the sub-facing request form itself (validateSessionRequestInput)
-- still enforces its own 5-90 cap in application code regardless of what the DB allows here.
alter table public.session_requests
  drop constraint if exists session_requests_daily_limit_minutes_check;

alter table public.session_requests
  add constraint session_requests_daily_limit_minutes_check
  check (daily_limit_minutes between 5 and 1440);

-- Opt-in, paid add-on chosen by the sub at request time (see pricing.ts/SessionPricing.kt
-- for the surcharge) -- on-demand only, no automatic scanning/classification of photos.
alter table public.session_requests
  add column if not exists gallery_access_enabled boolean not null default false;

-- "Leave it entirely up to Principessa" request mode: the sub skips specifying terms (the
-- columns above still get a placeholder value to satisfy the not-null/check constraints) and
-- the keyholder sets the real daily_limit_minutes/requested_days/forced_sleep_enabled/
-- gallery_access_enabled freely at approval time instead of just accepting what was asked for.
alter table public.session_requests
  add column if not exists full_discretion boolean not null default false;

-- The activation-code flow (approve minted a one-time code the sub typed in to activate) was
-- replaced by a single-tap Activate that just checks the device's own bearer token against its
-- most recent approved request -- the hash column and its index are dead. activation_code_expires_at
-- is kept and reused as a generic "approval expires at" timestamp (see session-flow.ts) rather
-- than dropped, since the concept of an approval expiring is still meaningful without a code.
drop index if exists session_requests_activation_code_hash_key;

alter table public.session_requests
  drop column if exists activation_code_hash;

create index if not exists session_requests_status_created_at_idx
  on public.session_requests (status, created_at desc);

create table if not exists public.subs (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  status text not null default 'invited',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subs_status_check check (status in ('invited', 'active', 'archived'))
);

-- Chosen once at self-registration (never re-asked); used for the in-app leaderboard, ranked
-- by the sum of that sub's activated sessions' session_days (total days spent locked -- session
-- length/limit are free now, so price_usd is mostly 0 and not a meaningful ranking metric), and
-- as the persistent identity a sub registers with (see /api/register) -- never reusable once
-- taken, even if the original device/install is gone.
alter table public.subs
  add column if not exists username text;

create unique index if not exists subs_username_lower_key
  on public.subs (lower(username))
  where username is not null;

-- The pairing-code flow (admin pre-creates a sub + generates a one-time code the device
-- redeems) was replaced by direct self-registration with a unique username -- these columns
-- and their index are dead.
drop index if exists subs_pairing_code_hash_key;

alter table public.subs
  drop column if exists pairing_code_hash;

alter table public.subs
  drop column if exists pairing_code_expires_at;

alter table public.subs
  drop column if exists pending_session_days;

alter table public.subs
  drop column if exists pending_daily_limit_minutes;

alter table public.subs
  drop column if exists pending_forced_sleep_enabled;

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

-- A device name is chosen once at self-registration alongside the username and can't be
-- reused afterward either, same as username -- both together are what identifies a sub, so
-- letting either be claimed twice would let someone impersonate an existing registration.
create unique index if not exists devices_device_name_lower_key
  on public.devices (lower(device_name));

-- Hash of Android's ANDROID_ID -- stable across app uninstall/reinstall for the same device +
-- app signing key (only changes on factory reset). Lets /api/register recognize "this is the
-- same physical device registering again" and rotate its secret in place instead of forcing a
-- paid/approved sub to create a brand new account (with a new username) after reinstalling.
alter table public.devices
  add column if not exists hardware_id_hash text;

create unique index if not exists devices_hardware_id_hash_key
  on public.devices (hardware_id_hash)
  where hardware_id_hash is not null;

-- Latest-known-location only (no history table) -- periodic background reports overwrite
-- these each time, matching how last_seen_at already works for heartbeats.
alter table public.devices
  add column if not exists last_latitude double precision;

alter table public.devices
  add column if not exists last_longitude double precision;

alter table public.devices
  add column if not exists last_location_accuracy_m double precision;

alter table public.devices
  add column if not exists last_location_at timestamptz;

-- Rolling log (capped, FIFO-trimmed client-side and again on write) of DNS lookups the
-- content filter observed -- hostnames only, meant to help the keyholder tune the
-- blocklist, not a full browsing history.
alter table public.devices
  add column if not exists recent_dns_queries jsonb not null default '[]'::jsonb;

-- Full snapshot of user-visible installed apps (package name + label), overwritten on each
-- report -- lets the keyholder pick apps to block from a list instead of typing package
-- names blind.
alter table public.devices
  add column if not exists installed_apps jsonb not null default '[]'::jsonb;

create unique index if not exists devices_device_secret_hash_key
  on public.devices (device_secret_hash)
  where device_secret_hash is not null;

create index if not exists devices_sub_id_idx
  on public.devices (sub_id);

alter table public.session_requests
  add column if not exists sub_id uuid references public.subs(id) on delete cascade;

alter table public.session_requests
  add column if not exists device_id uuid references public.devices(id) on delete cascade;

-- payment_note was added for a manual Throne-payment reference note but was never wired into
-- any route or UI; dropped rather than left as a dead, unpopulated column.
alter table public.session_requests
  drop column if exists payment_note;

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

-- Widened from the original 5-90 so the keyholder can set a daily limit above 90 minutes via
-- the desktop admin's "Save Config" (see validateAdminSessionUpdateInput in
-- request-validation.ts) -- what matters for this cap is who's making the request, not a
-- blanket limit; the sub-facing session-request form still enforces its own 5-90 cap.
alter table public.sessions
  drop constraint if exists sessions_daily_limit_minutes_check;

alter table public.sessions
  add constraint sessions_daily_limit_minutes_check
  check (daily_limit_minutes between 5 and 1440);

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

-- Package names the keyholder blocks outright regardless of the daily-limit/sleep state --
-- independent of (and in addition to) the whole-device lock.
alter table public.sessions
  add column if not exists blocked_packages jsonb not null default '[]'::jsonb;

-- Sparse per-weekday overrides for daily_limit_minutes/sleep_start_time/sleep_end_time, e.g.
-- {"sat": {"dailyLimitMinutes": 60}, "sun": {"dailyLimitMinutes": 60, "sleepStartTime": "23:30"}}.
-- Keys are lowercase 3-letter weekday abbreviations (mon..sun); a day with no entry falls back
-- to the session's own daily_limit_minutes/sleep_start_time/sleep_end_time.
alter table public.sessions
  add column if not exists weekday_overrides jsonb not null default '{}'::jsonb;

-- Content filtering (VPN + DNS blocklist on the device) is opt-in from the sub's side even
-- once the keyholder turns it on here -- Android requires a one-time local VPN consent
-- dialog that can't be granted remotely.
alter table public.sessions
  add column if not exists content_filter_enabled boolean not null default false;

alter table public.sessions
  add column if not exists blocked_domains jsonb not null default '[]'::jsonb;

-- Step-count reward: reaching step_reward_steps_required steps in a local day grants a
-- one-time step_reward_bonus_minutes bonus added to that day's effective limit (device-side
-- only, tracked per session_daily_usage row below) -- not a per-1000-steps repeating bonus.
alter table public.sessions
  add column if not exists step_reward_enabled boolean not null default false;

alter table public.sessions
  add column if not exists step_reward_steps_required integer not null default 5000;

alter table public.sessions
  add column if not exists step_reward_bonus_minutes integer not null default 20;

-- Opt-in, paid gallery access -- on-demand viewing only (a remote "capture_gallery" action
-- returns the most recent photos), never automatic scanning/classification.
alter table public.sessions
  add column if not exists gallery_access_enabled boolean not null default false;

-- Computed server-side once at activation time using the same formula as session-pricing.ts
-- (mirrored in Android/desktop for display) -- session length/daily limit are free, so this is
-- just the flat fee for opt-in extras (gallery access, full_discretion) and is mostly 0. The
-- leaderboard ranks by session_days (days locked) instead, not this column.
alter table public.sessions
  add column if not exists price_usd integer not null default 0;

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

alter table public.session_daily_usage
  add column if not exists steps_recorded integer;

alter table public.session_daily_usage
  add column if not exists step_bonus_minutes_earned integer not null default 0;

-- Per-app foreground minutes for that local day, e.g. {"com.instagram.android": 42}. Reported
-- alongside the existing total used_minutes; a top-N summary for the admin UI, not a full log.
alter table public.session_daily_usage
  add column if not exists per_app_minutes jsonb not null default '{}'::jsonb;

create index if not exists session_daily_usage_session_id_idx
  on public.session_daily_usage (session_id, local_date desc);

-- Two-way sub<->keyholder messaging, scoped to a session. Kept intentionally simple (no
-- attachments, no threads) -- this is a "ask your keyholder something" channel, most
-- importantly reachable from the block screen when the daily limit is reached.
create table if not exists public.session_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  sub_id uuid references public.subs(id) on delete set null,
  sender text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint session_messages_sender_check check (sender in ('sub', 'admin')),
  constraint session_messages_body_check check (char_length(body) between 1 and 1000)
);

create index if not exists session_messages_session_id_idx
  on public.session_messages (session_id, created_at desc);

-- Paid, time-boxed exception to a session's blocked_packages list -- only offered for
-- sessions long enough (session_days >= 7, enforced in the route, not here) for a one-off
-- app unlock to make sense. Fixed $3/app, fixed 24h from approval; the keyholder approves
-- manually after confirming payment via Throne (no in-app payment integration).
create table if not exists public.app_unlock_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  sub_id uuid references public.subs(id) on delete set null,
  package_name text not null,
  status text not null default 'pending',
  price_usd integer not null default 3,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_unlock_requests_status_check
    check (status in ('pending', 'approved', 'rejected'))
);

create index if not exists app_unlock_requests_session_id_idx
  on public.app_unlock_requests (session_id, created_at desc);

create index if not exists app_unlock_requests_status_idx
  on public.app_unlock_requests (status, created_at desc);

-- Widened from the original $5 -- the route always passes UNLOCK_PRICE_USD explicitly on
-- insert, so this default only matters for direct/manual inserts, kept in sync anyway.
alter table public.app_unlock_requests
  alter column price_usd set default 3;

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
  notification_access_granted boolean,
  autostart_acknowledged boolean,
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
  add column if not exists notification_access_granted boolean;

-- Reported so the keyholder can see whether the step-reward bonus can actually work on this
-- device -- ACTIVITY_RECOGNITION (needed for TYPE_STEP_COUNTER on API 29+) is a separate runtime
-- grant the sub might never give, in which case the toggle should be treated as inert.
alter table if exists public.device_heartbeats
  add column if not exists activity_recognition_granted boolean;

alter table if exists public.device_heartbeats
  add column if not exists autostart_acknowledged boolean;

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

alter table if exists public.device_heartbeats
  add column if not exists inside_persistence_penalty boolean;

alter table if exists public.device_heartbeats
  add column if not exists persistence_penalty_until timestamptz;

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
  check (action_type in ('force_lock', 'clear_local_usage', 'sync_config', 'capture_screenshot', 'set_wallpaper', 'capture_gallery', 'clear_persistence_penalty'));

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

-- Realtime + RLS for the desktop admin console. All existing REST routes use the service-role
-- client (backend/src/lib/server/supabase-admin.ts), which always bypasses RLS regardless of
-- whether it's enabled here -- so none of the routes above are affected by any of this. This is
-- purely additive: it lets the desktop admin's Electron renderer open its own read-only Supabase
-- Realtime subscription (see desktop-admin/src/lib/realtime.ts) instead of relying solely on
-- 60-second REST polling to notice new session/unlock requests, messages, and device heartbeats.
--
-- There is exactly one keyholder identity in this whole product (single-admin model, enforced by
-- ADMIN_EMAIL in backend/src/lib/server/admin-auth.ts) and no other flow ever mints a Supabase
-- Auth JWT (devices authenticate with a separate bearer-secret scheme, not Supabase Auth) -- so
-- "the request carries a valid Supabase Auth session" is already equivalent to "this is the
-- keyholder." A plain `auth.role() = 'authenticated'` policy is therefore sufficient; there is no
-- second identity for it to leak data to.
alter table public.session_requests enable row level security;
alter table public.app_unlock_requests enable row level security;
alter table public.session_messages enable row level security;
alter table public.device_heartbeats enable row level security;
alter table public.device_remote_actions enable row level security;

drop policy if exists admin_read_session_requests on public.session_requests;
create policy admin_read_session_requests
  on public.session_requests for select
  using (auth.role() = 'authenticated');

drop policy if exists admin_read_app_unlock_requests on public.app_unlock_requests;
create policy admin_read_app_unlock_requests
  on public.app_unlock_requests for select
  using (auth.role() = 'authenticated');

drop policy if exists admin_read_session_messages on public.session_messages;
create policy admin_read_session_messages
  on public.session_messages for select
  using (auth.role() = 'authenticated');

drop policy if exists admin_read_device_heartbeats on public.device_heartbeats;
create policy admin_read_device_heartbeats
  on public.device_heartbeats for select
  using (auth.role() = 'authenticated');

drop policy if exists admin_read_device_remote_actions on public.device_remote_actions;
create policy admin_read_device_remote_actions
  on public.device_remote_actions for select
  using (auth.role() = 'authenticated');

-- `alter publication ... add table` errors if the table is already a publication member, so this
-- guards each one with an existence check to stay safely re-runnable (this file gets re-pasted
-- into the Supabase SQL editor wholesale rather than run as incremental migrations).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'session_requests'
  ) then
    alter publication supabase_realtime add table public.session_requests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_unlock_requests'
  ) then
    alter publication supabase_realtime add table public.app_unlock_requests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'session_messages'
  ) then
    alter publication supabase_realtime add table public.session_messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'device_heartbeats'
  ) then
    alter publication supabase_realtime add table public.device_heartbeats;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'device_remote_actions'
  ) then
    alter publication supabase_realtime add table public.device_remote_actions;
  end if;
end $$;
