import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type HeartbeatRow = {
  accessibility_granted: boolean | null;
  accessibility_running: boolean | null;
  active_session_present: boolean | null;
  app_version: string | null;
  battery_optimization_ignored: boolean | null;
  blocking_active: boolean | null;
  blocking_method: string | null;
  blocking_required: boolean | null;
  daily_limit_minutes: number | null;
  device_admin_granted: boolean | null;
  device_id: string | null;
  device_name: string | null;
  foreground_service_running: boolean | null;
  forced_sleep_enabled: boolean | null;
  forced_sleep_ready: boolean | null;
  id: string;
  inside_sleep_window: boolean | null;
  last_accessibility_event_at: string | null;
  last_protection_tick_at: string | null;
  last_remote_action_check_at: string | null;
  last_recovery_attempt_at: string | null;
  last_recovery_reason: string | null;
  last_protection_check_at: string | null;
  last_session_sync_at: string | null;
  last_usage_refresh_at: string | null;
  limit_reached: boolean | null;
  local_date: string | null;
  network_connected: boolean | null;
  overlay_active: boolean | null;
  overlay_permission_granted: boolean | null;
  overlay_ready: boolean | null;
  polling_interval_ms: number | null;
  polling_mode: string | null;
  platform: string;
  protection_broken_reasons: string[] | null;
  protection_healthy: boolean | null;
  protection_health_level: string | null;
  protection_health_status: string | null;
  protection_state: string | null;
  received_at: string;
  remaining_minutes: number | null;
  service_running: boolean | null;
  session_id: string | null;
  session_status: string | null;
  timezone: string | null;
  remote_action_queue_length: number | null;
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
      "id, device_id, session_id, received_at, device_name, platform, timezone, app_version, session_status, protection_state, protection_healthy, protection_health_level, protection_health_status, protection_broken_reasons, service_running, foreground_service_running, active_session_present, accessibility_granted, accessibility_running, forced_sleep_enabled, forced_sleep_ready, inside_sleep_window, usage_access_granted, device_admin_granted, blocking_required, blocking_active, blocking_method, overlay_permission_granted, overlay_ready, overlay_active, used_minutes, daily_limit_minutes, remaining_minutes, limit_reached, battery_optimization_ignored, last_accessibility_event_at, last_protection_tick_at, last_remote_action_check_at, last_recovery_attempt_at, last_recovery_reason, last_protection_check_at, last_session_sync_at, last_usage_refresh_at, local_date, network_connected, polling_interval_ms, polling_mode, remote_action_queue_length",
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
      activeSessionPresent: row.active_session_present,
      accessibilityGranted: row.accessibility_granted,
      accessibilityRunning: row.accessibility_running,
      appVersion: row.app_version,
      batteryOptimizationIgnored: row.battery_optimization_ignored,
      blockingActive: row.blocking_active,
      blockingMethod: row.blocking_method,
      blockingRequired: row.blocking_required,
      dailyLimitMinutes: row.daily_limit_minutes,
      deviceAdminGranted: row.device_admin_granted,
      deviceId: row.device_id,
      deviceName: row.device_name,
      foregroundServiceRunning: row.foreground_service_running,
      forcedSleepEnabled: row.forced_sleep_enabled,
      forcedSleepReady: row.forced_sleep_ready,
      insideSleepWindow: row.inside_sleep_window,
      lastAccessibilityEventAt: row.last_accessibility_event_at,
      lastProtectionTickAt: row.last_protection_tick_at,
      lastRemoteActionCheckAt: row.last_remote_action_check_at,
      lastRecoveryAttemptAt: row.last_recovery_attempt_at,
      lastRecoveryReason: row.last_recovery_reason,
      lastProtectionCheckAt: row.last_protection_check_at,
      lastSeenAt: row.received_at,
      lastSessionSyncAt: row.last_session_sync_at,
      lastUsageRefreshAt: row.last_usage_refresh_at,
      limitReached: row.limit_reached,
      localDate: row.local_date,
      networkConnected: row.network_connected,
      overlayActive: row.overlay_active,
      overlayPermissionGranted: row.overlay_permission_granted,
      overlayReady: row.overlay_ready,
      pollingIntervalMs: row.polling_interval_ms,
      pollingMode: row.polling_mode,
      platform: row.platform,
      protectionBrokenReasons: row.protection_broken_reasons ?? [],
      protectionHealthy: row.protection_healthy,
      protectionHealthLevel: row.protection_health_level,
      protectionHealthStatus: row.protection_health_status,
      protectionState: row.protection_state,
      remainingMinutes: row.remaining_minutes,
      serviceRunning: row.service_running,
      sessionId: row.session_id,
      sessionStatus: row.session_status,
      timezone: row.timezone,
      remoteActionQueueLength: row.remote_action_queue_length,
      usageAccessGranted: row.usage_access_granted,
      usedMinutes: row.used_minutes,
    }));

  return jsonOk({
    ok: true,
    devices,
  });
}
