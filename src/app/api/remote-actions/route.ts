import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
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
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const sessionOwnership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId: deviceAuth.device.id,
    sessionId,
    suppliedSupabase: supabase,
  });

  if (!sessionOwnership.ok) {
    return sessionOwnership.response;
  }

  const { data, error } = await supabase
    .from("device_remote_actions")
    .select("id, session_id, device_id, action_type, status, payload, requested_at")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .or(`device_id.is.null,device_id.eq.${deviceAuth.device.id}`)
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
