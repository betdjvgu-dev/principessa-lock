import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { readJsonBody, validateRemoteActionCreateInput, type RemoteActionCreateInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type SessionLookupRow = {
  device_id: string;
  id: string;
  status: string;
};

type CreatedActionRow = {
  id: string;
  status: string;
};

export async function POST(request: Request) {
  const authError = verifyAdminRequest(request);

  if (authError) {
    return authError;
  }

  const bodyResult = await readJsonBody<RemoteActionCreateInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateRemoteActionCreateInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  const { data: session, error: loadError } = await supabase
    .from("sessions")
    .select("id, device_id, status")
    .eq("id", validation.data.sessionId)
    .maybeSingle<SessionLookupRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load session for remote action.", loadError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (session.status !== "active") {
    return jsonError(409, "Remote actions can only be created for active sessions.");
  }

  const { data: action, error: insertError } = await supabase
    .from("device_remote_actions")
    .insert({
      action_type: validation.data.actionType,
      device_id: validation.data.deviceId ?? session.device_id ?? null,
      payload: validation.data.payload ?? {},
      session_id: validation.data.sessionId,
      status: "pending",
    })
    .select("id, status")
    .maybeSingle<CreatedActionRow>();

  if (insertError) {
    return jsonSupabaseError("Failed to create remote action.", insertError);
  }

  if (!action) {
    return jsonError(500, "Remote action creation did not return a row.");
  }

  return jsonOk({
    ok: true,
    action: {
      id: action.id,
      status: action.status,
    },
  });
}
