import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

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

type DeviceLocation = {
  accuracyMeters: number | null;
  latitude: number;
  longitude: number;
  recordedAt: string;
} | null;

type SessionRow = {
  activated_at: string;
  always_allowed_package: string | null;
  blocked_packages: string[];
  blocked_domains: string[];
  content_filter_enabled: boolean;
  weekday_overrides: Record<string, unknown>;
  config_version: number;
  daily_limit_minutes: number;
  device_id: string;
  device_name: string | null;
  device_location: DeviceLocation;
  recent_dns_queries: RawDnsQueryEntry[];
  installed_apps: RawInstalledApp[];
  ends_at: string;
  forced_sleep_enabled: boolean;
  gallery_access_enabled: boolean;
  id: string;
  paused_at: string | null;
  request_id: string;
  session_days: number;
  screen_time_enabled: boolean;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  step_reward_bonus_minutes: number;
  step_reward_enabled: boolean;
  step_reward_steps_required: number;
  sub_id: string | null;
  sub_label: string | null;
  timezone: string | null;
  updated_at: string;
};

type RawDnsQueryEntry = {
  blocked: boolean;
  domain: string;
  queriedAt: string;
};

type RawInstalledApp = {
  appName: string;
  packageName: string;
};

type RawDevice = {
  device_name: string;
  last_latitude: number | null;
  last_longitude: number | null;
  last_location_accuracy_m: number | null;
  last_location_at: string | null;
  recent_dns_queries: RawDnsQueryEntry[] | null;
  installed_apps: RawInstalledApp[] | null;
};

type RawSessionRow = {
  activated_at: string;
  always_allowed_package: string | null;
  blocked_packages: string[];
  blocked_domains: string[];
  content_filter_enabled: boolean;
  weekday_overrides: Record<string, unknown>;
  config_version: number;
  daily_limit_minutes: number;
  device_id: string;
  devices: RawDevice | RawDevice[] | null;
  ends_at: string;
  forced_sleep_enabled: boolean;
  gallery_access_enabled: boolean;
  id: string;
  paused_at: string | null;
  request_id: string;
  session_days: number;
  screen_time_enabled: boolean;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  step_reward_bonus_minutes: number;
  step_reward_enabled: boolean;
  step_reward_steps_required: number;
  sub_id: string | null;
  subs: { label: string } | { label: string }[] | null;
  timezone: string | null;
  updated_at: string;
};

function extractDevice(value: RawSessionRow["devices"]): RawDevice | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
}

function extractDeviceName(value: RawSessionRow["devices"]) {
  return extractDevice(value)?.device_name ?? null;
}

function extractDeviceLocation(value: RawSessionRow["devices"]): DeviceLocation {
  const device = extractDevice(value);

  if (!device || device.last_latitude === null || device.last_longitude === null || !device.last_location_at) {
    return null;
  }

  return {
    accuracyMeters: device.last_location_accuracy_m,
    latitude: device.last_latitude,
    longitude: device.last_longitude,
    recordedAt: device.last_location_at,
  };
}

function extractRecentDnsQueries(value: RawSessionRow["devices"]): RawDnsQueryEntry[] {
  return extractDevice(value)?.recent_dns_queries ?? [];
}

function extractInstalledApps(value: RawSessionRow["devices"]): RawInstalledApp[] {
  return extractDevice(value)?.installed_apps ?? [];
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
      "id, request_id, device_id, session_days, daily_limit_minutes, screen_time_enabled, always_allowed_package, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at, sub_id, blocked_packages, weekday_overrides, blocked_domains, content_filter_enabled, step_reward_enabled, step_reward_steps_required, step_reward_bonus_minutes, gallery_access_enabled, paused_at, devices(device_name, last_latitude, last_longitude, last_location_accuracy_m, last_location_at, recent_dns_queries, installed_apps), subs(label)",
    )
    .order("updated_at", { ascending: false })
    .limit(50)
    .returns<RawSessionRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load sessions.", error);
  }

  const sessions: SessionRow[] = (data ?? []).map((session) => ({
    activated_at: session.activated_at,
    always_allowed_package: session.always_allowed_package,
    blocked_packages: session.blocked_packages,
    blocked_domains: session.blocked_domains,
    content_filter_enabled: session.content_filter_enabled,
    weekday_overrides: session.weekday_overrides,
    config_version: session.config_version,
    daily_limit_minutes: session.daily_limit_minutes,
    device_id: session.device_id,
    device_name: extractDeviceName(session.devices),
    device_location: extractDeviceLocation(session.devices),
    recent_dns_queries: extractRecentDnsQueries(session.devices),
    installed_apps: extractInstalledApps(session.devices),
    ends_at: session.ends_at,
    forced_sleep_enabled: session.forced_sleep_enabled,
    gallery_access_enabled: session.gallery_access_enabled,
    id: session.id,
    paused_at: session.paused_at,
    request_id: session.request_id,
    session_days: session.session_days,
    screen_time_enabled: session.screen_time_enabled,
    sleep_end_time: session.sleep_end_time,
    sleep_start_time: session.sleep_start_time,
    starts_at: session.starts_at,
    status: session.status,
    step_reward_bonus_minutes: session.step_reward_bonus_minutes,
    step_reward_enabled: session.step_reward_enabled,
    step_reward_steps_required: session.step_reward_steps_required,
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

  const { data: unreadMessageRows, error: unreadMessageError } = await supabase
    .from("session_messages")
    .select("session_id")
    .in("session_id", sessionIds)
    .eq("sender", "sub")
    .is("read_at", null);

  if (unreadMessageError) {
    return jsonSupabaseError("Failed to load unread message counts.", unreadMessageError);
  }

  const unreadMessageCountBySession = new Map<string, number>();

  for (const row of unreadMessageRows ?? []) {
    const sessionId = (row as { session_id: string }).session_id;
    unreadMessageCountBySession.set(sessionId, (unreadMessageCountBySession.get(sessionId) ?? 0) + 1);
  }

  return jsonOk({
    ok: true,
    sessions: sessions.map((session) => {
      const latestHeartbeat = latestHeartbeatBySession.get(session.id);

      return {
        ...session,
        unread_message_count: unreadMessageCountBySession.get(session.id) ?? 0,
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
