import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { queueSyncConfigPush } from "@/lib/server/remote-action-dispatch";
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

type SessionRow = {
  activated_at: string;
  config_version: number;
  daily_limit_minutes: number;
  device_id: string;
  ends_at: string;
  forced_sleep_enabled: boolean;
  id: string;
  request_id: string;
  session_days: number;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  timezone: string | null;
  updated_at: string;
};

function formatSessionResponse(session: SessionRow) {
  return {
    activated_at: session.activated_at,
    config_version: session.config_version,
    daily_limit_minutes: session.daily_limit_minutes,
    device_id: session.device_id,
    ends_at: session.ends_at,
    forced_sleep_enabled: session.forced_sleep_enabled,
    id: session.id,
    request_id: session.request_id,
    session_days: session.session_days,
    sleep_end_time: session.sleep_end_time,
    sleep_start_time: session.sleep_start_time,
    starts_at: session.starts_at,
    status: session.status,
    timezone: session.timezone,
    updated_at: session.updated_at,
  };
}

export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "sessions:revoke");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: session, error: loadError } = await supabase
    .from("sessions")
    .select(
      "id, request_id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle<SessionRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load session.", loadError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (session.status !== "active") {
    return jsonError(409, "Only active sessions can be revoked.");
  }

  const { data: updatedSession, error: updateError } = await supabase
    .from("sessions")
    .update({
      config_version: session.config_version + 1,
      status: "revoked",
    })
    .eq("id", id)
    .eq("status", "active")
    .select(
      "id, request_id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, config_version, activated_at, updated_at",
    )
    .maybeSingle<SessionRow>();

  if (updateError) {
    return jsonSupabaseError("Failed to revoke session.", updateError);
  }

  if (!updatedSession) {
    return jsonError(409, "Session is no longer active.");
  }

  await queueSyncConfigPush(supabase, {
    deviceId: updatedSession.device_id,
    sessionId: updatedSession.id,
    subId: null,
  });

  return jsonOk({
    ok: true,
    session: formatSessionResponse(updatedSession),
  });
}
