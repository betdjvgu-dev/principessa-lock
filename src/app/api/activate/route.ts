import { hashActivationCode } from "@/lib/server/activation-codes";
import { jsonError, jsonOk } from "@/lib/server/api-response";
import { readJsonBody, validateActivationInput, type ActivationInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";
import { type SessionRequestRow } from "@/lib/server/session-flow";

type SessionRow = {
  activated_at: string;
  daily_limit_minutes: number;
  device_id: string;
  ends_at: string;
  forced_sleep_enabled: boolean;
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

export async function POST(request: Request) {
  const bodyResult = await readJsonBody<ActivationInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateActivationInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  const activationCodeHash = hashActivationCode(validation.data.activationCode);
  const { data: sessionRequest, error: loadError } = await supabase
    .from("session_requests")
    .select("*")
    .eq("activation_code_hash", activationCodeHash)
    .maybeSingle<SessionRequestRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load activation request.", loadError);
  }

  if (!sessionRequest) {
    return jsonError(404, "Activation code not found.");
  }

  if (sessionRequest.status === "activated") {
    return jsonError(409, "Activation code has already been used.");
  }

  if (sessionRequest.status !== "approved") {
    return jsonError(409, `Activation code is not usable because the request is ${sessionRequest.status}.`);
  }

  if (!sessionRequest.activation_code_expires_at) {
    return jsonError(500, "Approved request is missing activation expiry.");
  }

  const expiresAt = new Date(sessionRequest.activation_code_expires_at);

  if (Number.isNaN(expiresAt.getTime())) {
    return jsonError(500, "Stored activation expiry is invalid.");
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

    return jsonError(410, "Activation code has expired.");
  }

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .insert({
      device_name: validation.data.deviceName,
      platform: "android",
      timezone: validation.data.timezone ?? null,
    })
    .select("id")
    .single<{ id: string }>();

  if (deviceError) {
    return jsonSupabaseError("Failed to create device.", deviceError);
  }

  const startsAt = new Date();
  const endsAt = addDays(startsAt, sessionRequest.requested_days);
  const activatedAt = new Date().toISOString();

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      activated_at: activatedAt,
      daily_limit_minutes: sessionRequest.daily_limit_minutes,
      device_id: device.id,
      ends_at: endsAt.toISOString(),
      forced_sleep_enabled: sessionRequest.forced_sleep_enabled,
      request_id: sessionRequest.id,
      session_days: sessionRequest.requested_days,
      sleep_end_time: "07:00",
      sleep_start_time: "23:00",
      starts_at: startsAt.toISOString(),
      status: "active",
      timezone: validation.data.timezone ?? null,
    })
    .select("id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, activated_at, updated_at")
    .maybeSingle<SessionRow>();

  if (sessionError) {
    if (sessionError.code === "23505") {
      return jsonError(409, "Activation code has already been used.");
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
    return jsonSupabaseError("Session was created but the request status update failed.", updateError);
  }

  return jsonOk({
    ok: true,
    session: {
      id: session.id,
      deviceId: session.device_id,
      sessionDays: session.session_days,
      dailyLimitMinutes: session.daily_limit_minutes,
      forcedSleepEnabled: session.forced_sleep_enabled,
      sleepEndTime: session.sleep_end_time,
      sleepStartTime: session.sleep_start_time,
      timezone: session.timezone,
      startsAt: session.starts_at,
      endsAt: session.ends_at,
      status: session.status,
      updatedAt: session.updated_at,
      activatedAt: session.activated_at,
    },
  });
}
