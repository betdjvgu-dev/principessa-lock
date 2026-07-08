import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

const UNLOCK_DURATION_MS = 24 * 60 * 60 * 1000;

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "unlock-requests:approve");

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
  const approvedAt = new Date();
  const expiresAt = new Date(approvedAt.getTime() + UNLOCK_DURATION_MS);

  const { data: updated, error: updateError } = await supabase
    .from("app_unlock_requests")
    .update({
      approved_at: approvedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      rejected_at: null,
      status: "approved",
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, status, session_id, package_name, expires_at")
    .maybeSingle<{ id: string; status: string; session_id: string; package_name: string; expires_at: string }>();

  if (updateError) {
    return jsonSupabaseError("Failed to approve unlock request.", updateError);
  }

  if (!updated) {
    return jsonError(409, "Unlock request is no longer pending.");
  }

  return jsonOk({
    ok: true,
    request: {
      expiresAt: updated.expires_at,
      id: updated.id,
      packageName: updated.package_name,
      sessionId: updated.session_id,
      status: updated.status,
    },
  });
}
