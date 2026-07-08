import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import {
  readJsonBody,
  validateAdminSessionUpdateInput,
  type AdminSessionUpdateInput,
} from "@/lib/server/request-validation";
import { queueSyncConfigPush } from "@/lib/server/remote-action-dispatch";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type SessionRow = {
  activated_at: string;
  blocked_domains: string[];
  blocked_packages: string[];
  content_filter_enabled: boolean;
  config_version: number;
  daily_limit_minutes: number;
  device_id: string;
  ends_at: string;
  forced_sleep_enabled: boolean;
  gallery_access_enabled: boolean;
  id: string;
  request_id: string;
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
  weekday_overrides: Record<string, unknown>;
};

function addDays(timestamp: string, days: number) {
  const next = new Date(timestamp);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function formatSessionResponse(session: SessionRow) {
  return {
    activated_at: session.activated_at,
    blocked_domains: session.blocked_domains,
    blocked_packages: session.blocked_packages,
    content_filter_enabled: session.content_filter_enabled,
    weekday_overrides: session.weekday_overrides,
    config_version: session.config_version,
    daily_limit_minutes: session.daily_limit_minutes,
    device_id: session.device_id,
    ends_at: session.ends_at,
    forced_sleep_enabled: session.forced_sleep_enabled,
    gallery_access_enabled: session.gallery_access_enabled,
    id: session.id,
    request_id: session.request_id,
    session_days: session.session_days,
    sleep_end_time: session.sleep_end_time,
    sleep_start_time: session.sleep_start_time,
    starts_at: session.starts_at,
    status: session.status,
    step_reward_bonus_minutes: session.step_reward_bonus_minutes,
    step_reward_enabled: session.step_reward_enabled,
    step_reward_steps_required: session.step_reward_steps_required,
    timezone: session.timezone,
    updated_at: session.updated_at,
  };
}

function buildSessionUpdatePayload(session: SessionRow, input: AdminSessionUpdateInput) {
  const updatePayload: Record<string, unknown> = {};

  if (input.dailyLimitMinutes !== undefined && input.dailyLimitMinutes !== session.daily_limit_minutes) {
    updatePayload.daily_limit_minutes = input.dailyLimitMinutes;
  }

  if (input.forcedSleepEnabled !== undefined && input.forcedSleepEnabled !== session.forced_sleep_enabled) {
    updatePayload.forced_sleep_enabled = input.forcedSleepEnabled;
  }

  if (input.sleepStartTime !== undefined && input.sleepStartTime !== session.sleep_start_time) {
    updatePayload.sleep_start_time = input.sleepStartTime;
  }

  if (input.sleepEndTime !== undefined && input.sleepEndTime !== session.sleep_end_time) {
    updatePayload.sleep_end_time = input.sleepEndTime;
  }

  if (input.endsAt !== undefined && input.endsAt !== session.ends_at) {
    updatePayload.ends_at = new Date(input.endsAt).toISOString();
  }

  if (input.extendDays !== undefined) {
    updatePayload.ends_at = addDays(session.ends_at, input.extendDays);
  }

  if (input.status === "revoked" && session.status !== "revoked") {
    updatePayload.status = "revoked";
  }

  if (input.blockedPackages !== undefined) {
    updatePayload.blocked_packages = input.blockedPackages;
  }

  if (input.blockedDomains !== undefined) {
    updatePayload.blocked_domains = input.blockedDomains;
  }

  if (input.contentFilterEnabled !== undefined) {
    updatePayload.content_filter_enabled = input.contentFilterEnabled;
  }

  if (input.galleryAccessEnabled !== undefined) {
    updatePayload.gallery_access_enabled = input.galleryAccessEnabled;
  }

  if (input.stepRewardEnabled !== undefined) {
    updatePayload.step_reward_enabled = input.stepRewardEnabled;
  }

  if (input.stepRewardStepsRequired !== undefined) {
    updatePayload.step_reward_steps_required = input.stepRewardStepsRequired;
  }

  if (input.stepRewardBonusMinutes !== undefined) {
    updatePayload.step_reward_bonus_minutes = input.stepRewardBonusMinutes;
  }

  if (input.weekdayOverrides !== undefined) {
    updatePayload.weekday_overrides = input.weekdayOverrides;
  }

  return updatePayload;
}

export async function PATCH(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "sessions:update");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const bodyResult = await readJsonBody<AdminSessionUpdateInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateAdminSessionUpdateInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: session, error: loadError } = await supabase
    .from("sessions")
    .select(
      "id, request_id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at, blocked_packages, weekday_overrides, blocked_domains, content_filter_enabled, step_reward_enabled, step_reward_steps_required, step_reward_bonus_minutes, gallery_access_enabled",
    )
    .eq("id", id)
    .maybeSingle<SessionRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load session.", loadError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (session.status !== "active" && validation.data.status !== "revoked") {
    return jsonError(409, "Only active sessions can be updated.");
  }

  const updatePayload = buildSessionUpdatePayload(session, validation.data);

  if (Object.keys(updatePayload).length === 0) {
    return jsonOk({
      ok: true,
      session: formatSessionResponse(session),
    });
  }

  updatePayload.config_version = session.config_version + 1;

  const { data: updatedSession, error: updateError } = await supabase
    .from("sessions")
    .update(updatePayload)
    .eq("id", id)
    .select(
      "id, request_id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at, blocked_packages, weekday_overrides, blocked_domains, content_filter_enabled, step_reward_enabled, step_reward_steps_required, step_reward_bonus_minutes, gallery_access_enabled",
    )
    .maybeSingle<SessionRow>();

  if (updateError) {
    return jsonSupabaseError("Failed to update session.", updateError);
  }

  if (!updatedSession) {
    return jsonError(409, "Session could not be updated.");
  }

  // Awaited (not fire-and-forget) since a serverless function isn't guaranteed to keep running
  // background work after it returns a response. Without this, a rule change (daily limit,
  // blocklist, forced sleep window, etc.) only reached the device on its own next periodic sync
  // tick instead of immediately.
  await queueSyncConfigPush(supabase, {
    deviceId: updatedSession.device_id,
    sessionId: updatedSession.id,
    subId: null,
  });

  return jsonOk({
    ok: true,
    session: formatSessionResponse(updatedSession),
  });
}
