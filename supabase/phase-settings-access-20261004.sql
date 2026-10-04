-- Settings stay closed during an active session until the keyholder turns this on,
-- or the phone submits the correct settings PIN (which sets the same flag).
-- Apply in the Supabase SQL editor. Do not re-run schema.sql on an existing database.
alter table public.sessions
  add column if not exists settings_access_allowed boolean not null default false;
