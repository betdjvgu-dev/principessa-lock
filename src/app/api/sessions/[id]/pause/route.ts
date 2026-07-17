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

// The device calls this itself (via the protection tick, not a user action) the moment it detects
// Accessibility is gone -- without it, blocking can't be restored, blocked-app reopens can't be
// caught, and the whole enforcement model is broken. Pausing stops the daily-usage clock rather
// than letting a permission an OEM silently revoked count against the sub, or worse, silently not
// enforcing anything while pretending the session is running normally. See resume/route.ts for how
// the paused time gets credited back once Accessibility returns.
export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many requests. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "sessions:pause",
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
    .select("paused_at, status")
    .eq("id", id)
    .maybeSingle<{ paused_at: string | null; status: string }>();

  if (sessionError) {
    return jsonSupabaseError("Failed to load session.", sessionError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (session.status !== "active") {
    return jsonError(409, "Session is not active.");
  }

  // Idempotent: a device that's already paused (e.g. a retried tick) just gets the existing
  // paused_at back rather than resetting the clock to "now" and quietly eating the time already
  // spent paused.
  if (session.paused_at) {
    return jsonOk({ ok: true, pausedAt: session.paused_at });
  }

  const pausedAt = new Date().toISOString();
  const { error: updateError } = await supabase.from("sessions").update({ paused_at: pausedAt }).eq("id", id).is("paused_at", null);

  if (updateError) {
    return jsonSupabaseError("Failed to pause session.", updateError);
  }

  return jsonOk({ ok: true, pausedAt });
}
