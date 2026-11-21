import { jsonError, jsonOk } from "@/lib/server/api-response";
import { notifyAdminDevices } from "@/lib/server/admin-push";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { sendNewSessionRequestPush, sendSessionRequestDecisionPush } from "@/lib/server/fcm";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { validateSessionRequestInput, readJsonBody, type SessionRequestInput } from "@/lib/server/request-validation";
import { shouldAutoApproveSessionRequest } from "@/lib/server/session-pricing";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";
import { ownSessionRequest, type OwnSessionRequestRow } from "@/lib/server/own-session-request";

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

// device_name intentionally comes from the authenticated device row, not the client-supplied
// input.deviceName -- the device's name is fixed at registration (unique, immutable), so trusting
// a value re-typed in the session-request form would let a request claim a different name than
// what's actually registered, with nothing tying the two together.
//
// All options are free. Normal requests auto-approve for registered devices;
// full-discretion requests still wait for the admin to choose their actual terms.
function buildInsertPayload(
  input: SessionRequestInput,
  deviceId: string,
  deviceName: string,
  subId: string | null,
  autoApprove: boolean,
) {
  const base = {
    always_allowed_package: input.alwaysAllowedPackage ?? null,
    daily_limit_minutes: input.dailyLimitMinutes,
    device_id: deviceId,
    device_name: deviceName,
    forced_sleep_enabled: input.forcedSleepEnabled,
    full_discretion: input.fullDiscretion,
    gallery_access_enabled: input.galleryAccessEnabled,
    // "Leave it up to Principessa" hands every term -- gallery access included -- to the
    // keyholder, and the device already forces the gallery OS permission at activation for a
    // full-discretion request (SessionRequestViewModel: requiresGalleryAccess = ... || fullDiscretion),
    // so the sub has effectively consented by choosing it. Without treating full discretion as
    // consent here, the keyholder's Gallery Access toggle on a discretionary request could never
    // be enabled -- approve route rejects it with "not consented" -- even though the sub granted
    // the photo permission on-device.
    gallery_access_consented: input.galleryAccessEnabled || input.fullDiscretion,
    requested_days: input.sessionDays,
    screen_time_enabled: input.screenTimeEnabled,
    sub_id: subId,
  };

  if (!autoApprove) {
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

  const supabase = getSupabaseAdminClient();

  // A lapsed approval must not permanently prevent a recovered device from requesting again.
  // The status/deadline predicates preserve activations and concurrent approval renewals.
  const { error: expiryError } = await supabase.from("session_requests")
    .update({ status: "expired" })
    .eq("device_id", deviceAuth.device.id)
    .eq("status", "approved")
    .or(`activation_code_expires_at.is.null,activation_code_expires_at.lte.${new Date().toISOString()}`);
  if (expiryError) return jsonSupabaseError("Failed to check session approval expiry.", expiryError);

  // Without this, a sub could submit a second request while an earlier one was still
  // pending/approved-but-not-yet-activated -- confirmed happening during testing, and it left
  // the keyholder looking at two simultaneous "waiting for approval" entries for the same
  // device with no way to tell which one the sub's app actually intended to activate.
  const { data: outstandingRequest, error: outstandingError } = await supabase
    .from("session_requests")
    .select("id, status")
    .eq("device_id", deviceAuth.device.id)
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle<{ id: string; status: string }>();

  if (outstandingError) {
    return jsonSupabaseError("Failed to check for an outstanding session request.", outstandingError);
  }

  if (outstandingRequest) {
    return jsonError(
      409,
      outstandingRequest.status === "approved"
        ? "You already have an approved request waiting to be activated. Activate it before submitting a new one."
        : "You already have a session request waiting for approval. Wait for a decision before submitting another.",
    );
  }

  const autoApprove = shouldAutoApproveSessionRequest(validation.data.fullDiscretion);

  const { data, error } = await supabase
    .from("session_requests")
    .insert(buildInsertPayload(validation.data, deviceAuth.device.id, deviceAuth.device.deviceName, deviceAuth.device.subId, autoApprove))
    .select("id, status")
    .single<CreateSessionRequestRow>();

  if (error) {
    return jsonSupabaseError("Failed to create session request.", error);
  }

  if (autoApprove) {
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
    await notifyAdminDevices(token => sendNewSessionRequestPush(token));
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
  const lookup = () => supabase
    .from("session_requests")
    .select("id, status, device_name, requested_days, daily_limit_minutes, screen_time_enabled, always_allowed_package, forced_sleep_enabled, gallery_access_enabled, full_discretion, activation_code_expires_at")
    .eq("device_id", deviceAuth.device.id);
  const newest = (query: ReturnType<typeof lookup>) => query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle<OwnSessionRequestRow>();
  // Prefer the same actionable requests that prevent submission; history is only a fallback.
  let { data, error } = await newest(lookup().or(
    `status.eq.pending,and(status.eq.approved,activation_code_expires_at.gt.${new Date().toISOString()})`
  ));
  if (!error && !data) ({ data, error } = await newest(lookup()));

  if (error) {
    return jsonSupabaseError("Failed to load session request status.", error);
  }

  return jsonOk({
    ok: true,
    request: data ? ownSessionRequest(data) : null,
  });
}
