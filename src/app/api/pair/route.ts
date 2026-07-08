import { jsonError, jsonOk } from "@/lib/server/api-response";
import { hashPairingCode } from "@/lib/server/activation-codes";
import { generateDeviceSecret, hashDeviceSecret } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validatePairInput, type PairInput } from "@/lib/server/request-validation";
import { calculateSessionPriceUsd } from "@/lib/server/session-pricing";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type ClaimedSubRow = {
  id: string;
  pending_daily_limit_minutes: number | null;
  pending_forced_sleep_enabled: boolean | null;
  pending_session_days: number | null;
  username: string | null;
};

type SessionRow = {
  activated_at: string;
  config_version: number;
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
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many pairing attempts. Please wait before trying again.",
    limit: 20,
    request,
    routeKey: "pair:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<PairInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validatePairInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const { deviceName, pairingCode, timezone, username } = validation.data;

  const supabase = getSupabaseAdminClient();
  const pairingCodeHash = hashPairingCode(pairingCode);
  const nowIso = new Date().toISOString();

  // Username is chosen once, at first pairing, and never re-asked -- re-pairing (reinstall,
  // new device) reuses whatever's already on the sub row instead of overwriting it. Read-only
  // pre-check; the actual claim below is still the atomic step that prevents a race.
  const { data: precheckSub } = await supabase
    .from("subs")
    .select("username")
    .eq("pairing_code_hash", pairingCodeHash)
    .maybeSingle<{ username: string | null }>();

  const needsUsername = precheckSub ? !precheckSub.username : false;

  if (needsUsername && !username) {
    return jsonError(400, "Choose a username to finish pairing.");
  }

  const { data: claimedSub, error: claimError } = await supabase
    .from("subs")
    .update({
      pairing_code_expires_at: null,
      pairing_code_hash: null,
      pending_daily_limit_minutes: null,
      pending_forced_sleep_enabled: null,
      pending_session_days: null,
      status: "active",
      ...(needsUsername && username ? { username } : {}),
    })
    .eq("pairing_code_hash", pairingCodeHash)
    .gt("pairing_code_expires_at", nowIso)
    .select("id, pending_session_days, pending_daily_limit_minutes, pending_forced_sleep_enabled, username")
    .maybeSingle<ClaimedSubRow>();

  if (claimError) {
    if (claimError.code === "23505") {
      return jsonError(409, "That username is already taken. Choose another and try again.");
    }

    return jsonSupabaseError("Failed to claim pairing code.", claimError);
  }

  if (!claimedSub) {
    const { data: existingSub, error: lookupError } = await supabase
      .from("subs")
      .select("id")
      .eq("pairing_code_hash", pairingCodeHash)
      .maybeSingle<{ id: string }>();

    if (lookupError) {
      return jsonSupabaseError("Failed to load pairing code.", lookupError);
    }

    if (existingSub) {
      return jsonError(410, "Pairing code has expired.");
    }

    return jsonError(404, "Invalid pairing code.");
  }

  if (
    claimedSub.pending_session_days === null ||
    claimedSub.pending_daily_limit_minutes === null ||
    claimedSub.pending_forced_sleep_enabled === null
  ) {
    return jsonError(500, "Pairing code is missing its session terms.");
  }

  const deviceSecret = generateDeviceSecret();

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .insert({
      device_name: deviceName,
      device_secret_created_at: nowIso,
      device_secret_hash: hashDeviceSecret(deviceSecret),
      platform: "android",
      sub_id: claimedSub.id,
      timezone: timezone ?? null,
    })
    .select("id")
    .single<{ id: string }>();

  if (deviceError) {
    return jsonSupabaseError("Failed to create device.", deviceError);
  }

  // The pairing code already carries the keyholder-approved session terms, so the
  // first session is created immediately instead of requiring a second (activation)
  // code round-trip. The session_requests row exists only to satisfy the schema's
  // audit trail / foreign key, already marked as activated.
  const { data: sessionRequest, error: sessionRequestError } = await supabase
    .from("session_requests")
    .insert({
      activated_at: nowIso,
      approved_at: nowIso,
      daily_limit_minutes: claimedSub.pending_daily_limit_minutes,
      device_id: device.id,
      device_name: deviceName,
      forced_sleep_enabled: claimedSub.pending_forced_sleep_enabled,
      requested_days: claimedSub.pending_session_days,
      status: "activated",
      sub_id: claimedSub.id,
    })
    .select("id")
    .single<{ id: string }>();

  if (sessionRequestError) {
    return jsonSupabaseError("Device was created but the session record could not be started.", sessionRequestError);
  }

  const startsAt = new Date();
  const endsAt = addDays(startsAt, claimedSub.pending_session_days);

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      activated_at: nowIso,
      daily_limit_minutes: claimedSub.pending_daily_limit_minutes,
      device_id: device.id,
      ends_at: endsAt.toISOString(),
      forced_sleep_enabled: claimedSub.pending_forced_sleep_enabled,
      price_usd: calculateSessionPriceUsd(claimedSub.pending_session_days, claimedSub.pending_daily_limit_minutes),
      request_id: sessionRequest.id,
      session_days: claimedSub.pending_session_days,
      sleep_end_time: "07:00",
      sleep_start_time: "23:00",
      starts_at: startsAt.toISOString(),
      status: "active",
      sub_id: claimedSub.id,
      timezone: timezone ?? null,
    })
    .select(
      "id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at",
    )
    .maybeSingle<SessionRow>();

  if (sessionError || !session) {
    return jsonSupabaseError(
      "Device was created but the session could not be started.",
      sessionError ?? { message: "Session creation did not return a row." },
    );
  }

  return jsonOk({
    device: {
      deviceSecret,
      id: device.id,
    },
    ok: true,
    session: {
      id: session.id,
      deviceId: session.device_id,
      sessionDays: session.session_days,
      dailyLimitMinutes: session.daily_limit_minutes,
      forcedSleepEnabled: session.forced_sleep_enabled,
      configVersion: session.config_version,
      sleepEndTime: session.sleep_end_time,
      sleepStartTime: session.sleep_start_time,
      timezone: session.timezone,
      startsAt: session.starts_at,
      endsAt: session.ends_at,
      status: session.status,
      updatedAt: session.updated_at,
      activatedAt: session.activated_at,
    },
    subId: claimedSub.id,
    username: claimedSub.username,
  });
}
