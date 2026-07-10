import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateActivateInput, type ActivateInput } from "@/lib/server/request-validation";
import { calculateSessionPriceUsd } from "@/lib/server/session-pricing";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";
import { type SessionRequestRow } from "@/lib/server/session-flow";

type SessionRow = {
  activated_at: string;
  config_version: number;
  daily_limit_minutes: number;
  device_id: string;
  ends_at: string;
  forced_sleep_enabled: boolean;
  gallery_access_enabled: boolean;
  id: string;
  session_days: number;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  timezone: string | null;
  updated_at: string;
};

function addDays(timestamp: Date, days: number) {
  const next = new Date(timestamp);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
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
      deviceId: session.device_id,
      sessionDays: session.session_days,
      dailyLimitMinutes: session.daily_limit_minutes,
      forcedSleepEnabled: session.forced_sleep_enabled,
      galleryAccessEnabled: session.gallery_access_enabled,
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
      .select("id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, gallery_access_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at")
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
  // Recover that row before checking approval expiry or attempting another insert.
  const { data: sessionForRequest, error: sessionForRequestError } = await supabase
    .from("sessions")
    .select("id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, gallery_access_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at")
    .eq("request_id", sessionRequest.id)
    .eq("device_id", deviceAuth.device.id)
    .eq("status", "active")
    .maybeSingle<SessionRow>();

  if (sessionForRequestError) {
    return jsonSupabaseError("Failed to check the existing session.", sessionForRequestError);
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

  if (validation.data.timezone) {
    await supabase
      .from("devices")
      .update({ timezone: validation.data.timezone })
      .eq("id", deviceAuth.device.id);
  }

  const startsAt = new Date();
  const endsAt = addDays(startsAt, sessionRequest.requested_days);
  const activatedAt = new Date().toISOString();

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      activated_at: activatedAt,
      daily_limit_minutes: sessionRequest.daily_limit_minutes,
      device_id: deviceAuth.device.id,
      ends_at: endsAt.toISOString(),
      forced_sleep_enabled: sessionRequest.forced_sleep_enabled,
      gallery_access_enabled: sessionRequest.gallery_access_enabled,
      price_usd: calculateSessionPriceUsd(
        sessionRequest.full_discretion,
        sessionRequest.gallery_access_enabled,
        sessionRequest.daily_limit_minutes,
      ),
      request_id: sessionRequest.id,
      session_days: sessionRequest.requested_days,
      sleep_end_time: "07:00",
      sleep_start_time: "23:00",
      starts_at: startsAt.toISOString(),
      status: "active",
      sub_id: sessionRequest.sub_id,
      timezone: validation.data.timezone ?? null,
    })
    .select("id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, gallery_access_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at")
    .maybeSingle<SessionRow>();

  if (sessionError) {
    if (sessionError.code === "23505") {
      const { data: concurrentSession, error: concurrentSessionError } = await supabase
        .from("sessions")
        .select("id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, gallery_access_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at")
        .eq("request_id", sessionRequest.id)
        .eq("device_id", deviceAuth.device.id)
        .eq("status", "active")
        .maybeSingle<SessionRow>();

      if (concurrentSessionError) {
        return jsonSupabaseError("Failed to recover the concurrently activated session.", concurrentSessionError);
      }

      if (concurrentSession) {
        return sessionResponse(deviceAuth.device.id, concurrentSession);
      }

      return jsonError(409, "This request has already been activated, but its session could not be recovered.");
    }

    return jsonSupabaseError("Failed to create session.", sessionError);
  }

  if (!session) {
    return jsonError(500, "Session creation did not return a row.");
  }

  const { error: updateError } = await supabase
    .from("session_requests")
    .update({
      activated_at: activatedAt,
      status: "activated",
    })
    .eq("id", sessionRequest.id)
    .eq("status", "approved");

  if (updateError) {
    // The session is already authoritative and usable. Returning it prevents a transient request
    // status update failure from stranding the Android client; the next activation retry repairs
    // the request through the sessionForRequest branch above.
    console.error("Session was created but the request status update failed.", updateError);
  }

  return sessionResponse(deviceAuth.device.id, session);
}
