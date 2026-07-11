import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

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
  const rateLimitError = await enforceAdminRateLimit(request, "unlock-requests:reject");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Unlock request id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: updated, error: updateError } = await supabase
    .from("app_unlock_requests")
    .update({
      rejected_at: new Date().toISOString(),
      status: "rejected",
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle<{ id: string; status: string }>();

  if (updateError) {
    return jsonSupabaseError("Failed to reject unlock request.", updateError);
  }

  if (!updated) {
    return jsonError(409, "Unlock request is no longer pending.");
  }

  return jsonOk({
    ok: true,
    request: {
      id: updated.id,
      status: updated.status,
    },
  });
}
