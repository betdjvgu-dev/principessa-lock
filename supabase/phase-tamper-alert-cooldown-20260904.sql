begin;

-- Rate-limits keyholder tamper pushes per device: OEM battery management restarts the
-- accessibility service repeatedly, and each restart is a real permission transition, so the
-- edge trigger alone still produced a continuous stream of identical alerts.
alter table public.devices
  add column if not exists last_tamper_alert_at timestamptz;

alter table public.devices
  add column if not exists last_tamper_alert_reason text;

commit;
