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

type SubRow = {
  id: string;
  status: string;
};

// Rejecting deletes the sub outright rather than archiving it -- devices.sub_id cascades, so
// this also removes the paired device row, freeing the username and device name for reuse
// instead of leaving them permanently reserved by a registration that never got approved.
export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "subs:reject");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Sub id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: deletedSub, error: deleteError } = await supabase
    .from("subs")
    .delete()
    .eq("id", id)
    .eq("status", "invited")
    .select("id, status")
    .maybeSingle<SubRow>();

  if (deleteError) {
    return jsonSupabaseError("Failed to reject registration.", deleteError);
  }

  if (!deletedSub) {
    return jsonError(409, "This registration is not pending approval.");
  }

  return jsonOk({
    ok: true,
    sub: {
      id: deletedSub.id,
    },
  });
}
