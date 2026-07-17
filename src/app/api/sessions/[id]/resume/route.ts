import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
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

// Called by the device itself the moment the protection tick sees Accessibility granted again
// while the session is still marked paused. Credits the elapsed paused duration onto ends_at --
// the sub shouldn't lose session time to a permission that was out of their hands (an OEM
// silently revoking it, a system update resetting it), the same reasoning behind pausing in the
// first place (see pause/route.ts).
export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many requests. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "sessions:resume",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const sessionOwnership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId: deviceAuth.device.id,
    sessionId: id,
    suppliedSupabase: supabase,
  });

  if (!sessionOwnership.ok) {
    return sessionOwnership.response;
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("ends_at, paused_at")
    .eq("id", id)
    .maybeSingle<{ ends_at: string; paused_at: string | null }>();

  if (sessionError) {
    return jsonSupabaseError("Failed to load session.", sessionError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (!session.paused_at) {
    // Already resumed (e.g. a retried tick) -- report the current ends_at rather than erroring,
    // so a client that missed the first response can still learn the real end time.
    return jsonOk({ ok: true, endsAt: session.ends_at, pausedAt: null });
  }

  const pausedDurationMs = Date.now() - new Date(session.paused_at).getTime();
  const newEndsAt = new Date(new Date(session.ends_at).getTime() + Math.max(0, pausedDurationMs)).toISOString();

  const { data: updated, error: updateError } = await supabase
    .from("sessions")
    .update({ ends_at: newEndsAt, paused_at: null })
    .eq("id", id)
    .not("paused_at", "is", null)
    .select("ends_at")
    .maybeSingle<{ ends_at: string }>();

  if (updateError) {
    return jsonSupabaseError("Failed to resume session.", updateError);
  }

  return jsonOk({ ok: true, endsAt: updated?.ends_at ?? newEndsAt, pausedAt: null });
}
