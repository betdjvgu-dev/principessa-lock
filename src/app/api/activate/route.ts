import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateActivateInput, type ActivateInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";
import { type SessionRequestRow } from "@/lib/server/session-flow";
import { notifyAdminSessionActivated } from "@/lib/server/session-activation-notification";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type SessionRow = {
  activated_at: string;
  always_allowed_package: string | null;
  config_version: number;
  daily_limit_minutes: number;
  device_id: string;
  ends_at: string;
  forced_sleep_enabled: boolean;
  gallery_access_enabled: boolean;
  id: string;
  paused_at: string | null;
  screen_time_enabled: boolean;
  session_days: number;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  timezone: string | null;
  updated_at: string;
};

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdminClient>;

// Applied unconditionally up front (before any of the several possible return paths below --
// fresh activation, restored-after-drop, or recovered-from-a-partial-failure) so a device
// reporting why its previous local session disappeared is captured regardless of which path
// this particular call takes.
async function applyDeviceUpdateFromActivateInput(
  supabase: SupabaseAdminClient,
  deviceId: string,
  validationData: ActivateInput,
) {
  const deviceUpdate: Record<string, string> = {};

  if (validationData.timezone) {
    deviceUpdate.timezone = validationData.timezone;
  }

  // Best-effort, informational only -- surfaces why the device's previous local session
  // disappeared (see SessionClearReasonSupport.kt) so the keyholder can see it in the admin
  // panel instead of relying on the sub to accurately relay whatever the app showed on-screen.
  if (validationData.lastSessionClearReason) {
    deviceUpdate.last_session_clear_reason = validationData.lastSessionClearReason;
    deviceUpdate.last_session_clear_at = validationData.lastSessionClearAt ?? new Date().toISOString();
  }

  if (Object.keys(deviceUpdate).length > 0) {
    await supabase.from("devices").update(deviceUpdate).eq("id", deviceId);
  }
}

function normalizeTimestamp(value: string) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function sessionResponse(deviceId: string, session: SessionRow) {
  const startsAt = normalizeTimestamp(session.starts_at);
  const endsAt = normalizeTimestamp(session.ends_at);
  const updatedAt = normalizeTimestamp(session.updated_at);
  const activatedAt = normalizeTimestamp(session.activated_at);

  if (!startsAt || !endsAt || !updatedAt || !activatedAt) {
    return jsonError(500, "Stored session timestamps are invalid.");
  }

  return jsonOk({
    device: { id: deviceId },
    ok: true,
    session: {
      id: session.id,
      alwaysAllowedPackage: session.always_allowed_package,
      deviceId: session.device_id,
      sessionDays: session.session_days,
      dailyLimitMinutes: session.daily_limit_minutes,
      forcedSleepEnabled: session.forced_sleep_enabled,
      galleryAccessEnabled: session.gallery_access_enabled,
      pausedAt: session.paused_at,
      screenTimeEnabled: session.screen_time_enabled,
      configVersion: session.config_version,
      sleepEndTime: session.sleep_end_time,
      sleepStartTime: session.sleep_start_time,
      timezone: session.timezone,
      startsAt,
      endsAt,
      status: session.status,
      updatedAt,
      activatedAt,
    },
  });
}

// No activation code anymore -- the device is already proven by its device-secret bearer token
// (requireAuthenticatedDevice), so activating just means "create a session from my own most
// recent approved request." One tap in the Android app, no code to type or copy.
export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many activation attempts. Please wait before trying again.",
    limit: 20,
    request,
    routeKey: "activation:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const deviceAuth = await requireAuthenticatedDevice(request);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const bodyResult = await readJsonBody<ActivateInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateActivateInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  await applyDeviceUpdateFromActivateInput(supabase, deviceAuth.device.id, validation.data);

  const { data: sessionRequest, error: loadError } = await supabase
    .from("session_requests")
    .select("*")
    .eq("device_id", deviceAuth.device.id)
    .eq("status", "approved")
    .order("approved_at", { ascending: false })
    .limit(1)
    .maybeSingle<SessionRequestRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load approved session request.", loadError);
  }

  if (!sessionRequest) {
    // The most common way to land here isn't "there was never an approved request" -- it's that
    // a previous /api/activate call already succeeded (session created, request flipped to
    // "activated") but its response never reached the device (dropped connection, app killed
    // mid-request, etc.), so the device retried and now finds nothing "approved" left. Rather
    // than erroring a device that's actually already active, hand back its existing active
    // session so a retry is self-healing instead of stranding the sub on an error screen forever.
    const { data: existingSession, error: existingSessionError } = await supabase
      .from("sessions")
      .select("id, device_id, session_days, daily_limit_minutes, screen_time_enabled, always_allowed_package, forced_sleep_enabled, gallery_access_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at, paused_at")
      .eq("device_id", deviceAuth.device.id)
      .eq("status", "active")
      .order("activated_at", { ascending: false })
      .limit(1)
      .maybeSingle<SessionRow>();

    if (existingSessionError) {
      return jsonSupabaseError("Failed to recover the active session.", existingSessionError);
    }

    if (existingSession) {
      return sessionResponse(deviceAuth.device.id, existingSession);
    }

    return jsonError(404, "No approved session request is waiting to be activated.");
  }

  // A session may already exist even while its request still says "approved" if the previous
  // activation created the session but the follow-up request update or HTTP response failed.
  // Recover that row before checking approval expiry or attempting another insert. Deliberately
  // not filtered to status="active" here -- an approved request whose session was already
  // revoked/completed is a *terminal* request, not a fresh one to activate. Filtering by status
  // up front would miss that row entirely and fall through to creating a brand new session,
  // silently resurrecting one the keyholder had just revoked.
  const { data: sessionForRequest, error: sessionForRequestError } = await supabase
    .from("sessions")
    .select("id, device_id, session_days, daily_limit_minutes, screen_time_enabled, always_allowed_package, forced_sleep_enabled, gallery_access_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at, paused_at")
    .eq("request_id", sessionRequest.id)
    .eq("device_id", deviceAuth.device.id)
    .maybeSingle<SessionRow>();

  if (sessionForRequestError) {
    return jsonSupabaseError("Failed to check the existing session.", sessionForRequestError);
  }

  if (sessionForRequest && sessionForRequest.status !== "active") {
    await supabase
      .from("session_requests")
      .update({ status: "expired" })
      .eq("id", sessionRequest.id)
      .eq("status", "approved");

    return jsonError(410, "This session has already ended. Ask your keyholder to approve a new request.");
  }

  if (sessionForRequest) {
    const { error: repairError } = await supabase
      .from("session_requests")
      .update({
        activated_at: sessionForRequest.activated_at,
        status: "activated",
      })
      .eq("id", sessionRequest.id)
      .eq("status", "approved");

    if (repairError) {
      console.error("Existing session was recovered but its request status could not be repaired.", repairError);
    }

    return sessionResponse(deviceAuth.device.id, sessionForRequest);
  }

  if (!sessionRequest.activation_code_expires_at) {
    return jsonError(500, "Approved request is missing an approval expiry.");
  }

  const expiresAt = new Date(sessionRequest.activation_code_expires_at);

  if (Number.isNaN(expiresAt.getTime())) {
    return jsonError(500, "Stored approval expiry is invalid.");
  }

  if (expiresAt.getTime() <= Date.now()) {
    const { error: expireError } = await supabase
      .from("session_requests")
      .update({ status: "expired" })
      .eq("id", sessionRequest.id)
      .eq("status", "approved");

    if (expireError) {
      return jsonSupabaseError("Failed to expire session request.", expireError);
    }

    return jsonError(410, "Approval has expired. Ask your keyholder to approve a new request.");
  }

  // The database serializes activation per device and commits all three changes together.
  const { data: activation, error } = await supabase.rpc("activate_device_session", {
    p_device_id: deviceAuth.device.id,
    p_request_id: sessionRequest.id,
    p_timezone: validation.data.timezone ?? null,
  });
  if (error) {
    if (error.message?.includes("activation_expired")) return jsonError(410, "Approval has expired. Ask your keyholder to approve a new request.");
    if (error.message?.includes("activation_terminal")) return jsonError(410, "This session has already ended. Request a new session.");
    if (error.message?.includes("activation_unavailable")) return jsonError(409, "Request changed. Refresh and try again.");
    return jsonSupabaseError("Failed to activate session.", error);
  }
  if (!activation?.session) return jsonError(500, "Activation did not return a session.");
  const session = activation.session as SessionRow;
  if (activation.created) await notifyAdminSessionActivated({
    sessionId: session.id, deviceName: deviceAuth.device.deviceName,
    sessionDays: session.session_days, dailyLimitMinutes: session.daily_limit_minutes,
  });
  return sessionResponse(deviceAuth.device.id, session);
}
