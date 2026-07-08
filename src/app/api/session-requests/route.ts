import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { validateSessionRequestInput, readJsonBody, type SessionRequestInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type CreateSessionRequestRow = {
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

export function GET() {
  return jsonError(405, "Method not allowed.");
}
