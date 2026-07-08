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

type RemoteActionRow = {
  action_type: string;
  completed_at: string | null;
  error_message: string | null;
  failed_at: string | null;
  id: string;
  requested_at: string;
  result_payload: Record<string, unknown>;
  status: string;
};

export async function GET(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "remote-actions:get");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Remote action id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: action, error } = await supabase
    .from("device_remote_actions")
    .select("id, action_type, status, result_payload, error_message, requested_at, completed_at, failed_at")
    .eq("id", id)
    .maybeSingle<RemoteActionRow>();

  if (error) {
    return jsonSupabaseError("Failed to load remote action.", error);
  }

  if (!action) {
    return jsonError(404, "Remote action not found.");
  }

  return jsonOk({
    action: {
      id: action.id,
      actionType: action.action_type,
      completedAt: action.completed_at,
      errorMessage: action.error_message,
      failedAt: action.failed_at,
      requestedAt: action.requested_at,
      resultPayload: action.result_payload,
      status: action.status,
    },
    ok: true,
  });
}
