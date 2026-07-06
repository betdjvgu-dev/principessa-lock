import { jsonError, jsonOk } from "@/lib/server/api-response";
import { readJsonBody, validateRemoteActionCompleteInput, type RemoteActionCompleteInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type RemoteActionStatusRow = {
  id: string;
  status: string;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Remote action id is required.");
  }

  const bodyResult = await readJsonBody<RemoteActionCompleteInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateRemoteActionCompleteInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  const { data: action, error: loadError } = await supabase
    .from("device_remote_actions")
    .select("id, status")
    .eq("id", id)
    .maybeSingle<RemoteActionStatusRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load remote action.", loadError);
  }

  if (!action) {
    return jsonError(404, "Remote action not found.");
  }

  if (action.status !== "pending") {
    return jsonError(409, "Remote action is no longer pending.");
  }

  const now = new Date().toISOString();
  const updatePayload = validation.data.ok
    ? {
        completed_at: now,
        error_message: null,
        failed_at: null,
        result_payload: validation.data.result ?? {},
        status: "completed",
      }
    : {
        completed_at: null,
        error_message: validation.data.errorMessage ?? "Remote action failed on device.",
        failed_at: now,
        result_payload: validation.data.result ?? {},
        status: "failed",
      };

  const { data: updatedAction, error: updateError } = await supabase
    .from("device_remote_actions")
    .update(updatePayload)
    .eq("id", id)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle<RemoteActionStatusRow>();

  if (updateError) {
    return jsonSupabaseError("Failed to update remote action status.", updateError);
  }

  if (!updatedAction) {
    return jsonError(409, "Remote action is no longer pending.");
  }

  return jsonOk({
    ok: true,
    action: {
      id: updatedAction.id,
      status: updatedAction.status,
    },
  });
}
