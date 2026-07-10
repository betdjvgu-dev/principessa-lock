import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { sendNewSessionRequestPush } from "@/lib/server/fcm";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { validateSessionRequestInput, readJsonBody, type SessionRequestInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type CreateSessionRequestRow = {
  id: string;
  status: string;
};

type OwnRequestStatusRow = {
  id: string;
  status: string;
};

// device_name intentionally comes from the authenticated device row, not the client-supplied
// input.deviceName -- the device's name is fixed at registration (unique, immutable), so trusting
// a value re-typed in the session-request form would let a request claim a different name than
// what's actually registered, with nothing tying the two together.
function buildInsertPayload(input: SessionRequestInput, deviceId: string, deviceName: string, subId: string | null) {
  return {
    daily_limit_minutes: input.dailyLimitMinutes,
    device_id: deviceId,
    device_name: deviceName,
    forced_sleep_enabled: input.forcedSleepEnabled,
    full_discretion: input.fullDiscretion,
    gallery_access_enabled: input.galleryAccessEnabled,
    requested_days: input.sessionDays,
    sub_id: subId,
  };
}

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many session request attempts. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "session-requests:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const deviceAuth = await requireAuthenticatedDevice(request);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const bodyResult = await readJsonBody<SessionRequestInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateSessionRequestInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_requests")
    .insert(buildInsertPayload(validation.data, deviceAuth.device.id, deviceAuth.device.deviceName, deviceAuth.device.subId))
    .select("id, status")
    .single<CreateSessionRequestRow>();

  if (error) {
    return jsonSupabaseError("Failed to create session request.", error);
  }

  // Single-admin model -- there is at most one row in admin_push_tokens, for whichever
  // physical device the keyholder is currently logged into the in-app admin console on.
  const { data: adminToken } = await supabase
    .from("admin_push_tokens")
    .select("fcm_token")
    .maybeSingle<{ fcm_token: string | null }>();

  await sendNewSessionRequestPush(adminToken?.fcm_token);

  return jsonOk(
    {
      ok: true,
      request: {
        id: data.id,
        status: data.status,
      },
    },
    { status: 201 },
  );
}

// No activation code to relay out-of-band anymore -- the Android app polls this while a request
// is pending/approved so it knows the moment it can show the one-tap "Activate" button.
export async function GET(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many status checks. Please wait before trying again.",
    limit: 60,
    request,
    routeKey: "session-requests:status",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const deviceAuth = await requireAuthenticatedDevice(request);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_requests")
    .select("id, status")
    .eq("device_id", deviceAuth.device.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<OwnRequestStatusRow>();

  if (error) {
    return jsonSupabaseError("Failed to load session request status.", error);
  }

  return jsonOk({
    ok: true,
    request: data ? { id: data.id, status: data.status } : null,
  });
}
