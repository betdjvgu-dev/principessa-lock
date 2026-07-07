import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
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
  const rateLimitError = enforceRateLimit({
    errorMessage: "Too many heartbeat requests. Please wait before sending another heartbeat.",
    limit: 120,
    request,
    routeKey: "heartbeat:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

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
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const sessionOwnership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId: deviceAuth.device.id,
    claimedDeviceId: heartbeat.deviceId,
    sessionId: heartbeat.sessionId,
    suppliedSupabase: supabase,
  });

  if (!sessionOwnership.ok) {
    return sessionOwnership.response;
  }

  const { error: insertError } = await supabase.from("device_heartbeats").insert({
    accessibility_granted: heartbeat.accessibilityGranted ?? null,
    accessibility_running: heartbeat.accessibilityRunning ?? null,
    active_session_present: heartbeat.activeSessionPresent ?? null,
    app_version: heartbeat.appVersion ?? null,
    battery_optimization_ignored: heartbeat.batteryOptimizationIgnored ?? null,
    blocking_active: heartbeat.blockingActive ?? null,
    blocking_method: heartbeat.blockingMethod ?? null,
    blocking_required: heartbeat.blockingRequired ?? null,
    daily_limit_minutes: heartbeat.dailyLimitMinutes ?? null,
    device_admin_granted: heartbeat.deviceAdminGranted ?? null,
    device_id: deviceAuth.device.id,
    device_name: heartbeat.deviceName,
    foreground_service_running: heartbeat.foregroundServiceRunning ?? heartbeat.serviceRunning ?? null,
    forced_sleep_enabled: heartbeat.forcedSleepEnabled ?? null,
    forced_sleep_ready: heartbeat.forcedSleepReady ?? null,
    inside_sleep_window: heartbeat.insideSleepWindow ?? null,
    last_accessibility_event_at: parseTimestampOrNull(heartbeat.lastAccessibilityEventAt),
    last_protection_tick_at: parseTimestampOrNull(heartbeat.lastProtectionTickAt),
    last_remote_action_check_at: parseTimestampOrNull(heartbeat.lastRemoteActionCheckAt),
    last_recovery_attempt_at: parseTimestampOrNull(heartbeat.lastRecoveryAttemptAt),
    last_recovery_reason: heartbeat.lastRecoveryReason ?? null,
    last_protection_check_at: parseTimestampOrNull(heartbeat.lastProtectionCheckAt),
    last_session_sync_at: parseTimestampOrNull(heartbeat.lastSessionSyncAt),
    last_usage_refresh_at: parseTimestampOrNull(heartbeat.lastUsageRefreshAt),
    limit_reached: heartbeat.limitReached ?? null,
    local_date: heartbeat.localDate ?? null,
    network_connected: heartbeat.networkConnected ?? null,
    overlay_active: heartbeat.overlayActive ?? null,
    overlay_permission_granted: heartbeat.overlayPermissionGranted ?? null,
    overlay_ready: heartbeat.overlayReady ?? null,
    payload: bodyResult.data,
    polling_interval_ms: heartbeat.pollingIntervalMs ?? null,
    polling_mode: heartbeat.pollingMode ?? null,
    platform: "android",
    protection_broken_reasons: heartbeat.protectionBrokenReasons ?? [],
    protection_healthy: heartbeat.protectionHealthy ?? null,
    protection_health_level: heartbeat.protectionHealthLevel ?? heartbeat.protectionHealthStatus ?? null,
    protection_health_status: heartbeat.protectionHealthStatus ?? null,
    protection_state: heartbeat.protectionState,
    remaining_minutes: heartbeat.remainingMinutes ?? null,
    service_running: heartbeat.serviceRunning ?? null,
    session_id: heartbeat.sessionId,
    session_status: heartbeat.sessionStatus,
    sub_id: deviceAuth.device.subId,
    timezone: heartbeat.timezone ?? null,
    remote_action_queue_length: heartbeat.remoteActionQueueLength ?? null,
    usage_access_granted: heartbeat.usageAccessGranted ?? null,
    used_minutes: heartbeat.usedMinutes ?? null,
  });

  if (insertError) {
    if (insertError.code === "23503") {
      return jsonError(400, "Heartbeat references an unknown device or session.");
    }

    return jsonSupabaseError("Failed to store heartbeat.", insertError);
  }

  const { error: updateError } = await supabase
    .from("devices")
    .update({
      device_name: heartbeat.deviceName,
      last_seen_at: new Date().toISOString(),
      timezone: heartbeat.timezone ?? null,
    })
    .eq("id", deviceAuth.device.id);

  if (updateError) {
    return jsonSupabaseError("Heartbeat was stored but device last seen update failed.", updateError);
  }

  return jsonOk({ ok: true });
}
