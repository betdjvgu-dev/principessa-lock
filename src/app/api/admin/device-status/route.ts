import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type HeartbeatRow = {
  app_version: string | null;
  battery_optimization_ignored: boolean | null;
  blocking_active: boolean | null;
  daily_limit_minutes: number | null;
  device_admin_granted: boolean | null;
  device_id: string | null;
  device_name: string | null;
  forced_sleep_enabled: boolean | null;
  id: string;
  inside_sleep_window: boolean | null;
  last_usage_refresh_at: string | null;
  limit_reached: boolean | null;
  local_date: string | null;
  platform: string;
  protection_state: string | null;
  received_at: string;
  remaining_minutes: number | null;
  session_id: string | null;
  session_status: string | null;
  timezone: string | null;
  usage_access_granted: boolean | null;
  used_minutes: number | null;
};

function buildGroupKey(row: HeartbeatRow) {
  return row.session_id ?? row.device_id ?? row.id;
}

export async function GET(request: Request) {
  const authError = verifyAdminRequest(request);

  if (authError) {
    return authError;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("device_heartbeats")
    .select(
      "id, device_id, session_id, received_at, device_name, platform, timezone, app_version, session_status, protection_state, forced_sleep_enabled, inside_sleep_window, usage_access_granted, device_admin_granted, blocking_active, used_minutes, daily_limit_minutes, remaining_minutes, limit_reached, battery_optimization_ignored, last_usage_refresh_at, local_date",
    )
    .order("received_at", { ascending: false })
    .returns<HeartbeatRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load device status.", error);
  }

  const latestByGroup = new Map<string, HeartbeatRow>();

  for (const row of data ?? []) {
    const key = buildGroupKey(row);

    if (!latestByGroup.has(key)) {
      latestByGroup.set(key, row);
    }
  }

  const devices = Array.from(latestByGroup.values())
    .sort((left, right) => new Date(right.received_at).getTime() - new Date(left.received_at).getTime())
    .map((row) => ({
      appVersion: row.app_version,
      batteryOptimizationIgnored: row.battery_optimization_ignored,
      blockingActive: row.blocking_active,
      dailyLimitMinutes: row.daily_limit_minutes,
      deviceAdminGranted: row.device_admin_granted,
      deviceId: row.device_id,
      deviceName: row.device_name,
      forcedSleepEnabled: row.forced_sleep_enabled,
      insideSleepWindow: row.inside_sleep_window,
      lastSeenAt: row.received_at,
      lastUsageRefreshAt: row.last_usage_refresh_at,
      limitReached: row.limit_reached,
      localDate: row.local_date,
      platform: row.platform,
      protectionState: row.protection_state,
      remainingMinutes: row.remaining_minutes,
      sessionId: row.session_id,
      sessionStatus: row.session_status,
      timezone: row.timezone,
      usageAccessGranted: row.usage_access_granted,
      usedMinutes: row.used_minutes,
    }));

  return jsonOk({
    ok: true,
    devices,
  });
}
