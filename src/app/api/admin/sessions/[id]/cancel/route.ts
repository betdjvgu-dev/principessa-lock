import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
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
  config_version: number;
  id: string;
  status: string;
};

export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "sessions:cancel");

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
    .select("id, status, config_version")
    .eq("id", id)
    .maybeSingle<SessionRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load session.", loadError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (session.status !== "active") {
    return jsonError(409, "Only active sessions can be canceled.");
  }

  const { data: updatedSession, error: updateError } = await supabase
    .from("sessions")
    .update({
      config_version: session.config_version + 1,
      ends_at: new Date().toISOString(),
      status: "revoked",
    })
    .eq("id", id)
    .eq("status", "active")
    .select("id, status, config_version")
    .maybeSingle<SessionRow>();

  if (updateError) {
    return jsonSupabaseError("Failed to cancel session.", updateError);
  }

  if (!updatedSession) {
    return jsonError(409, "Session is no longer active.");
  }

  return jsonOk({
    ok: true,
    session: {
      id: updatedSession.id,
      status: updatedSession.status,
    },
  });
}
