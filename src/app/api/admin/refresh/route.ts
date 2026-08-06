import { jsonError, jsonOk } from "@/lib/server/api-response";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-validation";
import { createIsolatedSupabaseClient } from "@/lib/server/supabase-admin";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type AdminRefreshInput = {
  refreshToken: string;
};

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many refresh attempts. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "admin:refresh",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<AdminRefreshInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const refreshToken = typeof bodyResult.data.refreshToken === "string" ? bodyResult.data.refreshToken.trim() : "";

  if (!refreshToken) {
    return jsonError(400, "refreshToken is required.");
  }

  // Isolated: refreshing establishes a session on the client, which must not leak into the
  // shared service-role client used for data access.
  const supabase = createIsolatedSupabaseClient();
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });

  if (error || !data.session) {
    return jsonError(401, "Session refresh failed. Please log in again.");
  }

  return jsonOk({
    ok: true,
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? null,
    },
  });
}
