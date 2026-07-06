import { jsonError, jsonOk } from "@/lib/server/api-response";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type RemoteActionRow = {
  action_type: string;
  device_id: string | null;
  id: string;
  payload: Record<string, unknown> | null;
  requested_at: string;
  session_id: string;
  status: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();

  if (!sessionId) {
    return jsonError(400, "sessionId query parameter is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("device_remote_actions")
    .select("id, session_id, device_id, action_type, status, payload, requested_at")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .order("requested_at", { ascending: true })
    .returns<RemoteActionRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load pending remote actions.", error);
  }

  return jsonOk({
    ok: true,
    actions: (data ?? []).map((action) => ({
      actionType: action.action_type,
      deviceId: action.device_id,
      id: action.id,
      payload: action.payload ?? {},
      requestedAt: action.requested_at,
      sessionId: action.session_id,
      status: action.status,
    })),
  });
}
