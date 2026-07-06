import { jsonError, jsonOk } from "@/lib/server/api-response";
import { readJsonBody, validateHeartbeatInput, type HeartbeatInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

function parseTimestampOrNull(value: string | undefined) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export async function POST(request: Request) {
  const bodyResult = await readJsonBody<HeartbeatInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateHeartbeatInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const heartbeat = validation.data;
  const supabase = getSupabaseAdminClient();
  const { error: insertError } = await supabase.from("device_heartbeats").insert({
    app_version: heartbeat.appVersion ?? null,
    battery_optimization_ignored: heartbeat.batteryOptimizationIgnored ?? null,
    blocking_active: heartbeat.blockingActive ?? null,
    daily_limit_minutes: heartbeat.dailyLimitMinutes ?? null,
    device_admin_granted: heartbeat.deviceAdminGranted ?? null,
    device_id: heartbeat.deviceId ?? null,
    device_name: heartbeat.deviceName,
    forced_sleep_enabled: heartbeat.forcedSleepEnabled ?? null,
    inside_sleep_window: heartbeat.insideSleepWindow ?? null,
    last_usage_refresh_at: parseTimestampOrNull(heartbeat.lastUsageRefreshAt),
    limit_reached: heartbeat.limitReached ?? null,
    local_date: heartbeat.localDate ?? null,
    payload: bodyResult.data,
    platform: "android",
    protection_state: heartbeat.protectionState,
    remaining_minutes: heartbeat.remainingMinutes ?? null,
    session_id: heartbeat.sessionId,
    session_status: heartbeat.sessionStatus,
    timezone: heartbeat.timezone ?? null,
    usage_access_granted: heartbeat.usageAccessGranted ?? null,
    used_minutes: heartbeat.usedMinutes ?? null,
  });

  if (insertError) {
    if (insertError.code === "23503") {
      return jsonError(400, "Heartbeat references an unknown device or session.");
    }

    return jsonSupabaseError("Failed to store heartbeat.", insertError);
  }

  if (heartbeat.deviceId) {
    const { error: updateError } = await supabase
      .from("devices")
      .update({
        device_name: heartbeat.deviceName,
        last_seen_at: new Date().toISOString(),
        timezone: heartbeat.timezone ?? null,
      })
      .eq("id", heartbeat.deviceId);

    if (updateError) {
      return jsonSupabaseError("Heartbeat was stored but device last seen update failed.", updateError);
    }
  }

  return jsonOk({ ok: true });
}
