import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { sendNewSessionRequestPush, sendSessionRequestDecisionPush } from "@/lib/server/fcm";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { validateSessionRequestInput, readJsonBody, type SessionRequestInput } from "@/lib/server/request-validation";
import { calculateSessionPriceUsd } from "@/lib/server/session-pricing";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

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
//
// A request that prices out to $0 (see calculateSessionPriceUsd) has nothing for the keyholder to
// manually confirm on Throne -- the only reason paid requests sit in "pending" is so she can
// verify the payment before approving. requireAuthenticatedDevice already refused to let this
// route run at all unless the requesting sub's status is "active" (genuinely approved, not just
// "invited"), so a free request can safely skip straight to "approved" here instead of waiting on
// a manual tap that has nothing left to check.
function buildInsertPayload(
  input: SessionRequestInput,
  deviceId: string,
  deviceName: string,
  subId: string | null,
  isFree: boolean,
) {
  const base = {
    daily_limit_minutes: input.dailyLimitMinutes,
    device_id: deviceId,
    device_name: deviceName,
    forced_sleep_enabled: input.forcedSleepEnabled,
    full_discretion: input.fullDiscretion,
    gallery_access_enabled: input.galleryAccessEnabled,
    requested_days: input.sessionDays,
    sub_id: subId,
  };

  if (!isFree) {
    return base;
  }

  return {
    ...base,
    activation_code_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    approved_at: new Date().toISOString(),
    status: "approved",
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

  const isFree =
    calculateSessionPriceUsd(validation.data.fullDiscretion, validation.data.galleryAccessEnabled, validation.data.dailyLimitMinutes) === 0;

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_requests")
    .insert(buildInsertPayload(validation.data, deviceAuth.device.id, deviceAuth.device.deviceName, deviceAuth.device.subId, isFree))
    .select("id, status")
    .single<CreateSessionRequestRow>();

  if (error) {
    return jsonSupabaseError("Failed to create session request.", error);
  }

  if (isFree) {
    // Nothing for the keyholder to review -- tell the sub's own device it's ready to activate
    // instead of paging the keyholder about a request that's already been decided.
    const { data: device } = await supabase
      .from("devices")
      .select("fcm_token")
      .eq("id", deviceAuth.device.id)
      .maybeSingle<{ fcm_token: string | null }>();

    await sendSessionRequestDecisionPush(device?.fcm_token);
  } else {
    // Single-admin model -- there is at most one row in admin_push_tokens, for whichever
    // physical device the keyholder is currently logged into the in-app admin console on.
    const { data: adminToken } = await supabase
      .from("admin_push_tokens")
      .select("fcm_token")
      .maybeSingle<{ fcm_token: string | null }>();

    await sendNewSessionRequestPush(adminToken?.fcm_token);
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
