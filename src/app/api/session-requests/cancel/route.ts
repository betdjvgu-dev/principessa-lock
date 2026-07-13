import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type CancelledRequestRow = {
  id: string;
  status: string;
};

// Only "approved" (not yet activated) is cancellable here -- a sub can no longer submit a new
// request while one is outstanding (see the duplicate-request guard in the sibling create
// route), so this is the only way out of an approved request they've changed their mind about.
// A "pending" request that's still awaiting the keyholder's review is deliberately left alone --
// there's nothing to undo yet, and the keyholder can simply reject it.
export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many cancel attempts. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "session-requests:cancel",
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
  const { data: cancelled, error } = await supabase
    .from("session_requests")
    .update({ status: "cancelled" })
    .eq("device_id", deviceAuth.device.id)
    .eq("status", "approved")
    .select("id, status")
    .maybeSingle<CancelledRequestRow>();

  if (error) {
    return jsonSupabaseError("Failed to cancel session request.", error);
  }

  if (!cancelled) {
    return jsonError(409, "There is no approved request waiting to be cancelled.");
  }

  return jsonOk({
    ok: true,
    request: {
      id: cancelled.id,
      status: cancelled.status,
    },
  });
}
