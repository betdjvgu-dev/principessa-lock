import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { sendSessionRequestDecisionPush } from "@/lib/server/fcm";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
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
  const rateLimitError = await enforceAdminRateLimit(request, "session-requests:reject");

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
    return jsonError(409, "Only pending session requests can be rejected.");
  }

  const rejectedAt = new Date().toISOString();

  const { data: updatedRequest, error: updateError } = await supabase
    .from("session_requests")
    .update({
      rejected_at: rejectedAt,
      status: "rejected",
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle<{ id: string; status: string }>();

  if (updateError) {
    return jsonSupabaseError("Failed to reject session request.", updateError);
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
