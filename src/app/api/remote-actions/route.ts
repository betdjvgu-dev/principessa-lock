import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

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

  // Recheck queued captures too: consent may have changed after the admin requested them.
  let actions = data ?? [];
  if (actions.some((action) => action.action_type === "capture_gallery")) {
    const { data: session, error: consentError } = await supabase.from("sessions")
      .select("gallery_access_enabled, status").eq("id", sessionId)
      .maybeSingle<{ gallery_access_enabled: boolean | null; status: string }>();
    if (consentError) return jsonSupabaseError("Failed to verify gallery access.", consentError);
    if (session?.gallery_access_enabled !== true || session.status !== "active") {
      const deniedIds = actions.filter((action) => action.action_type === "capture_gallery").map((action) => action.id);
      const { error: cancelError } = await supabase.from("device_remote_actions")
        .update({ status: "failed", failed_at: new Date().toISOString(), error_message: "Gallery access is not enabled for this session." })
        .in("id", deniedIds).eq("session_id", sessionId).eq("status", "pending");
      if (cancelError) return jsonSupabaseError("Failed to reject gallery capture.", cancelError);
      actions = actions.filter((action) => action.action_type !== "capture_gallery");
    }
  }

  return jsonOk({
    ok: true,
    actions: actions.map((action) => ({
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
