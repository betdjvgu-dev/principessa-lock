import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { sendRemoteActionPush } from "@/lib/server/fcm";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateRemoteActionCreateInput, type RemoteActionCreateInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type SessionLookupRow = {
  device_id: string;
  id: string;
  status: string;
  sub_id: string | null;
};

type CreatedActionRow = {
  id: string;
  status: string;
};

export async function POST(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "remote-actions");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
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
    .select("id, device_id, status, sub_id")
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
      sub_id: session.sub_id,
    })
    .select("id, status")
    .maybeSingle<CreatedActionRow>();

  if (insertError) {
    return jsonSupabaseError("Failed to create remote action.", insertError);
  }

  if (!action) {
    return jsonError(500, "Remote action creation did not return a row.");
  }

  const targetDeviceId = validation.data.deviceId ?? session.device_id ?? null;

  if (targetDeviceId) {
    const { data: device } = await supabase
      .from("devices")
      .select("fcm_token")
      .eq("id", targetDeviceId)
      .maybeSingle<{ fcm_token: string | null }>();

    await sendRemoteActionPush(device?.fcm_token);
  }

  return jsonOk({
    ok: true,
    action: {
      id: action.id,
      status: action.status,
    },
  });
}
