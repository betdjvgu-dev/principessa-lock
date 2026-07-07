import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type SessionHeartbeatSummaryRow = {
  blocking_active: boolean | null;
  daily_limit_minutes: number | null;
  protection_health_level: string | null;
  protection_health_status: string | null;
  protection_state: string | null;
  received_at: string;
  remaining_minutes: number | null;
  session_id: string | null;
  used_minutes: number | null;
};

type SessionRow = {
  activated_at: string;
  config_version: number;
  daily_limit_minutes: number;
  device_id: string;
  device_name: string | null;
  ends_at: string;
  forced_sleep_enabled: boolean;
  id: string;
  request_id: string;
  session_days: number;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  sub_id: string | null;
  sub_label: string | null;
  timezone: string | null;
  updated_at: string;
};

type RawSessionRow = {
  activated_at: string;
  config_version: number;
  daily_limit_minutes: number;
  device_id: string;
  devices: { device_name: string } | { device_name: string }[] | null;
  ends_at: string;
  forced_sleep_enabled: boolean;
  id: string;
  request_id: string;
  session_days: number;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  sub_id: string | null;
  subs: { label: string } | { label: string }[] | null;
  timezone: string | null;
  updated_at: string;
};

function extractDeviceName(value: RawSessionRow["devices"]) {
  if (Array.isArray(value)) {
    return value[0]?.device_name ?? null;
  }

  return value?.device_name ?? null;
}

function extractSubLabel(value: RawSessionRow["subs"]) {
  if (Array.isArray(value)) {
    return value[0]?.label ?? null;
  }

  return value?.label ?? null;
}

export async function GET(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "sessions:list");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("sessions")
    .select(
      "id, request_id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at, sub_id, devices(device_name), subs(label)",
    )
    .order("updated_at", { ascending: false })
    .limit(50)
    .returns<RawSessionRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load sessions.", error);
  }

  const sessions: SessionRow[] = (data ?? []).map((session) => ({
    activated_at: session.activated_at,
    config_version: session.config_version,
    daily_limit_minutes: session.daily_limit_minutes,
    device_id: session.device_id,
    device_name: extractDeviceName(session.devices),
    ends_at: session.ends_at,
    forced_sleep_enabled: session.forced_sleep_enabled,
    id: session.id,
    request_id: session.request_id,
    session_days: session.session_days,
    sleep_end_time: session.sleep_end_time,
    sleep_start_time: session.sleep_start_time,
    starts_at: session.starts_at,
    status: session.status,
    sub_id: session.sub_id,
    sub_label: extractSubLabel(session.subs),
    timezone: session.timezone,
    updated_at: session.updated_at,
  }));

  if (sessions.length === 0) {
    return jsonOk({
      ok: true,
      sessions: [],
    });
  }

  const sessionIds = sessions.map((session) => session.id);
  const { data: heartbeatRows, error: heartbeatError } = await supabase
    .from("device_heartbeats")
    .select(
      "session_id, received_at, used_minutes, daily_limit_minutes, remaining_minutes, protection_state, protection_health_level, protection_health_status, blocking_active",
    )
    .in("session_id", sessionIds)
    .order("received_at", { ascending: false })
    .returns<SessionHeartbeatSummaryRow[]>();

  if (heartbeatError) {
    return jsonSupabaseError("Failed to load session heartbeat summary.", heartbeatError);
  }

  const latestHeartbeatBySession = new Map<string, SessionHeartbeatSummaryRow>();

  for (const row of heartbeatRows ?? []) {
    if (!row.session_id || latestHeartbeatBySession.has(row.session_id)) {
      continue;
    }

    latestHeartbeatBySession.set(row.session_id, row);
  }

  return jsonOk({
    ok: true,
    sessions: sessions.map((session) => {
      const latestHeartbeat = latestHeartbeatBySession.get(session.id);

      return {
        ...session,
        latest_heartbeat: latestHeartbeat
          ? {
              blocking_active: latestHeartbeat.blocking_active,
              daily_limit_minutes: latestHeartbeat.daily_limit_minutes,
              protection_health:
                latestHeartbeat.protection_health_level ?? latestHeartbeat.protection_health_status ?? null,
              protection_state: latestHeartbeat.protection_state,
              received_at: latestHeartbeat.received_at,
              remaining_minutes: latestHeartbeat.remaining_minutes,
              used_minutes: latestHeartbeat.used_minutes,
            }
          : null,
      };
    }),
  });
}
