import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type SubRow = {
  id: string;
  status: string;
};

// Approving a registration just flips subs.status from "invited" to "active" -- the device
// already has its secret from /api/register, it just couldn't do anything functional until now
// (see requireAuthenticatedDevice's gating in device-auth.ts).
export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "subs:approve");

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
  const { data: updatedSub, error: updateError } = await supabase
    .from("subs")
    .update({ status: "active" })
    .eq("id", id)
    .eq("status", "invited")
    .select("id, status")
    .maybeSingle<SubRow>();

  if (updateError) {
    return jsonSupabaseError("Failed to approve registration.", updateError);
  }

  if (!updatedSub) {
    return jsonError(409, "This registration is not pending approval.");
  }

  return jsonOk({
    ok: true,
    sub: {
      id: updatedSub.id,
      status: updatedSub.status,
    },
  });
}
