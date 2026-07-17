import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

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
  ends_at: string;
  forced_sleep_enabled: boolean;
  gallery_access_enabled: boolean;
  id: string;
  screen_time_enabled: boolean;
  session_days: number;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  step_reward_bonus_minutes: number;
  step_reward_enabled: boolean;
  step_reward_steps_required: number;
  timezone: string | null;
  updated_at: string;
};

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const sessionOwnership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId: deviceAuth.device.id,
    sessionId: id,
    suppliedSupabase: supabase,
  });

  if (!sessionOwnership.ok) {
    return sessionOwnership.response;
  }

  const { data: session, error } = await supabase
    .from("sessions")
    .select("id, device_id, session_days, daily_limit_minutes, screen_time_enabled, always_allowed_package, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at, blocked_packages, weekday_overrides, blocked_domains, content_filter_enabled, step_reward_enabled, step_reward_steps_required, step_reward_bonus_minutes, gallery_access_enabled")
    .eq("id", id)
    .maybeSingle<SessionRow>();

  if (error) {
    return jsonSupabaseError("Failed to load session.", error);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  const nowIso = new Date().toISOString();
  const { data: unlocks } = await supabase
    .from("app_unlock_requests")
    .select("package_name")
    .eq("session_id", id)
    .eq("status", "approved")
    .gt("expires_at", nowIso)
    .returns<{ package_name: string }[]>();

  return jsonOk({
    ok: true,
    activatedAt: session.activated_at,
    alwaysAllowedPackage: session.always_allowed_package,
    blockedPackages: session.blocked_packages,
    unlockedPackages: (unlocks ?? []).map((row) => row.package_name),
    blockedDomains: session.blocked_domains,
    contentFilterEnabled: session.content_filter_enabled,
    weekdayOverrides: session.weekday_overrides,
    dailyLimitMinutes: session.daily_limit_minutes,
    deviceId: session.device_id,
    endsAt: session.ends_at,
    forcedSleepEnabled: session.forced_sleep_enabled,
    galleryAccessEnabled: session.gallery_access_enabled,
    screenTimeEnabled: session.screen_time_enabled,
    configVersion: session.config_version,
    sessionDays: session.session_days,
    sessionId: session.id,
    sleepEndTime: session.sleep_end_time,
    sleepStartTime: session.sleep_start_time,
    startsAt: session.starts_at,
    status: session.status,
    stepRewardBonusMinutes: session.step_reward_bonus_minutes,
    stepRewardEnabled: session.step_reward_enabled,
    stepRewardStepsRequired: session.step_reward_steps_required,
    timezone: session.timezone,
    updatedAt: session.updated_at,
  });
}
