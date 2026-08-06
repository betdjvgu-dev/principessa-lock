import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { sendProtectionTamperAlertPush } from "@/lib/server/fcm";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateHeartbeatInput, type HeartbeatInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

function parseTimestampOrNull(value: string | undefined) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
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

  // Snapshotted before inserting the new row below, so this reads as "what was true last time"
  // -- used only to detect a true-to-false transition on a critical permission, not stored or
  // compared any further.
  const { data: previousHeartbeat } = await supabase
    .from("device_heartbeats")
    .select("accessibility_granted, accessibility_running, overlay_permission_granted, device_admin_granted, usage_access_granted, protection_healthy")
    .eq("device_id", deviceAuth.device.id)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      accessibility_granted: boolean | null;
      accessibility_running: boolean | null;
      overlay_permission_granted: boolean | null;
      device_admin_granted: boolean | null;
      usage_access_granted: boolean | null;
      protection_healthy: boolean | null;
    }>();

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
    autostart_acknowledged: heartbeat.autostartAcknowledged ?? null,
    battery_optimization_ignored: heartbeat.batteryOptimizationIgnored ?? null,
    blocking_active: heartbeat.blockingActive ?? null,
    blocking_method: heartbeat.blockingMethod ?? null,
    blocking_required: heartbeat.blockingRequired ?? null,
    daily_limit_minutes: heartbeat.dailyLimitMinutes ?? null,
    debugger_attached: heartbeat.debuggerAttached ?? null,
    device_admin_granted: heartbeat.deviceAdminGranted ?? null,
    device_id: deviceAuth.device.id,
    device_name: heartbeat.deviceName,
    emulator_detected: heartbeat.emulatorDetected ?? null,
    foreground_service_running: heartbeat.foregroundServiceRunning ?? heartbeat.serviceRunning ?? null,
    forced_sleep_enabled: heartbeat.forcedSleepEnabled ?? null,
    forced_sleep_ready: heartbeat.forcedSleepReady ?? null,
    inside_sleep_window: heartbeat.insideSleepWindow ?? null,
    inside_persistence_penalty: heartbeat.insidePersistencePenalty ?? null,
    persistence_penalty_until: parseTimestampOrNull(heartbeat.persistencePenaltyUntil),
    last_failed_feature: heartbeat.lastFailedFeature ?? null,
    last_failed_stage: heartbeat.lastFailedStage ?? null,
    last_failed_detected_at: parseTimestampOrNull(heartbeat.lastFailedDetectedAt),
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
    activity_recognition_granted: heartbeat.activityRecognitionGranted ?? null,
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
    root_detected: heartbeat.rootDetected ?? null,
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

  // device_manufacturer/model/android_release/android_sdk_int are overwritten on every heartbeat
  // (not just at registration) so a device that registered before these columns existed gets
  // backfilled automatically, and a later OS update is reflected here instead of the dashboard
  // showing a permanently stale Android version.
  const { error: updateError } = await supabase
    .from("devices")
    .update({
      device_name: heartbeat.deviceName,
      last_seen_at: new Date().toISOString(),
      timezone: heartbeat.timezone ?? null,
      ...(heartbeat.deviceManufacturer !== undefined ? { device_manufacturer: heartbeat.deviceManufacturer } : {}),
      ...(heartbeat.deviceModel !== undefined ? { device_model: heartbeat.deviceModel } : {}),
      ...(heartbeat.androidRelease !== undefined ? { android_release: heartbeat.androidRelease } : {}),
      ...(heartbeat.androidSdkInt !== undefined ? { android_sdk_int: heartbeat.androidSdkInt } : {}),
    })
    .eq("id", deviceAuth.device.id);

  if (updateError) {
    return jsonSupabaseError("Heartbeat was stored but device last seen update failed.", updateError);
  }

  // Only fires on a true-to-false *transition* (not "still false from before"), so a sub who's
  // simply never granted an optional permission doesn't page the keyholder on every heartbeat --
  // only an actual loss does. accessibility_running (the service process still being alive) is
  // tracked separately from accessibility_granted (the permission itself) because an OEM can kill
  // the running service via aggressive battery/background restrictions without the permission
  // grant ever being revoked -- that's a real, silent gap otherwise.
  const lostPermissions: string[] = [];
  if (previousHeartbeat?.accessibility_granted === true && heartbeat.accessibilityGranted === false) {
    lostPermissions.push("Accessibility permission revoked");
  }
  if (previousHeartbeat?.accessibility_running === true && heartbeat.accessibilityRunning === false) {
    lostPermissions.push("Accessibility service stopped running");
  }
  if (previousHeartbeat?.overlay_permission_granted === true && heartbeat.overlayPermissionGranted === false) {
    lostPermissions.push("Display-over-other-apps revoked");
  }
  if (previousHeartbeat?.device_admin_granted === true && heartbeat.deviceAdminGranted === false) {
    lostPermissions.push("Device admin revoked");
  }
  if (previousHeartbeat?.usage_access_granted === true && heartbeat.usageAccessGranted === false) {
    lostPermissions.push("Usage access revoked");
  }
  const protectionJustBrokeDown = previousHeartbeat?.protection_healthy === true && heartbeat.protectionHealthy === false;

  // settings_tamper_attempt alone flips protectionHealthy false whenever App Info / Settings is
  // PIN-walled -- that is expected enforcement, not a silent escape. Pushing the keyholder's
  // Vault companion (admin_push_tokens) for every PIN wall was pure noise; real permission losses
  // and other broken reasons still alert below.
  const brokenReasons = heartbeat.protectionBrokenReasons ?? [];
  const onlySettingsTamper =
    brokenReasons.length > 0 &&
    brokenReasons.every((reason) => reason === "settings_tamper_attempt");
  const shouldAlertKeyholder =
    lostPermissions.length > 0 || (protectionJustBrokeDown && !onlySettingsTamper);

  if (shouldAlertKeyholder) {
    const reason = lostPermissions.length > 0 ? lostPermissions.join(", ") : "Protection health degraded";
    const { data: adminToken } = await supabase
      .from("admin_push_tokens")
      .select("fcm_token")
      .maybeSingle<{ fcm_token: string | null }>();

    await sendProtectionTamperAlertPush(adminToken?.fcm_token, heartbeat.deviceName, reason);
  }

  // Best-effort: only the fields needed for the usage-history chart. Missing any of them
  // (older app builds, a heartbeat sent before the session engine has a local date yet)
  // just skips this day's row rather than failing the whole heartbeat.
  if (heartbeat.localDate && heartbeat.usedMinutes !== undefined && heartbeat.dailyLimitMinutes !== undefined) {
    await supabase.from("session_daily_usage").upsert(
      {
        limit_minutes: heartbeat.dailyLimitMinutes,
        local_date: heartbeat.localDate,
        session_id: heartbeat.sessionId,
        step_bonus_minutes_earned: heartbeat.stepBonusMinutesEarnedToday ?? 0,
        steps_recorded: heartbeat.stepsToday ?? null,
        used_minutes: heartbeat.usedMinutes,
        ...(heartbeat.perAppMinutes !== undefined ? { per_app_minutes: heartbeat.perAppMinutes } : {}),
      },
      { onConflict: "session_id,local_date" },
    );
  }

  return jsonOk({ ok: true });
}
