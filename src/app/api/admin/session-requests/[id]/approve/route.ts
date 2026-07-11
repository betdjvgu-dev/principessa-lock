import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { sendSessionRequestDecisionPush } from "@/lib/server/fcm";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateApproveSessionRequestInput, type ApproveSessionRequestInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";
import { type SessionRequestRow } from "@/lib/server/session-flow";

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

export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "session-requests:approve");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session request id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: sessionRequest, error: loadError } = await supabase
    .from("session_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle<SessionRequestRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load session request.", loadError);
  }

  if (!sessionRequest) {
    return jsonError(404, "Session request not found.");
  }

  if (sessionRequest.status !== "pending") {
    return jsonError(409, "Only pending session requests can be approved.");
  }

  // Body is optional -- most approvals send none (accept the request as-is). Only a
  // full_discretion request actually uses overrides, but they're harmlessly ignored otherwise
  // rather than rejecting a body sent by an older/newer client.
  let overrideInput: unknown;

  try {
    const rawBody = await request.text();
    overrideInput = rawBody.trim() ? JSON.parse(rawBody) : undefined;
  } catch {
    return jsonError(400, "Invalid JSON request body.");
  }

  const overrideValidation = validateApproveSessionRequestInput(overrideInput);

  if (!overrideValidation.ok) {
    return overrideValidation.response;
  }

  const overrides: ApproveSessionRequestInput = sessionRequest.full_discretion ? overrideValidation.data : {};

  if (sessionRequest.full_discretion) {
    const { error: overrideError } = await supabase
      .from("session_requests")
      .update({
        daily_limit_minutes: overrides.dailyLimitMinutes ?? sessionRequest.daily_limit_minutes,
        forced_sleep_enabled: overrides.forcedSleepEnabled ?? sessionRequest.forced_sleep_enabled,
        gallery_access_enabled: overrides.galleryAccessEnabled ?? sessionRequest.gallery_access_enabled,
        requested_days: overrides.sessionDays ?? sessionRequest.requested_days,
      })
      .eq("id", id)
      .eq("status", "pending");

    if (overrideError) {
      return jsonSupabaseError("Failed to apply keyholder-set terms to the session request.", overrideError);
    }
  }

  // Approved requests stay activatable for 7 days -- if the sub never taps "Activate" in that
  // window, the request auto-expires instead of sitting around indefinitely. This reuses the
  // activation_code_expires_at column from the old code-based flow to avoid a schema migration;
  // it's just a generic "approval expires at" timestamp now.
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const approvedAt = new Date().toISOString();

  const { data: updatedRequest, error: updateError } = await supabase
    .from("session_requests")
    .update({
      activation_code_expires_at: expiresAt,
      approved_at: approvedAt,
      rejected_at: null,
      status: "approved",
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle<{ id: string; status: string }>();

  if (updateError) {
    return jsonSupabaseError("Failed to approve session request.", updateError);
  }

  if (!updatedRequest) {
    return jsonError(409, "Session request is no longer pending.");
  }

  if (sessionRequest.device_id) {
    const { data: device } = await supabase
      .from("devices")
      .select("fcm_token")
      .eq("id", sessionRequest.device_id)
      .maybeSingle<{ fcm_token: string | null }>();

    await sendSessionRequestDecisionPush(device?.fcm_token);
  }

  return jsonOk({
    ok: true,
    request: {
      id: updatedRequest.id,
      status: updatedRequest.status,
    },
  });
}
