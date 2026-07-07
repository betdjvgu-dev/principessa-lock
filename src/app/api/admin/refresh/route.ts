import { jsonError, jsonOk } from "@/lib/server/api-response";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

type AdminRefreshInput = {
  refreshToken: string;
};

export async function POST(request: Request) {
  const rateLimitError = enforceRateLimit({
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

  const supabase = getSupabaseAdminClient();
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
