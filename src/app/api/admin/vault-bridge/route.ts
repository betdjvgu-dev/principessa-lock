import { jsonError, jsonOk } from "@/lib/server/api-response";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-validation";
import { createIsolatedSupabaseClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

type VaultBridgeInput = {
  vaultAccessToken?: string;
};

/**
 * Exchanges a Vault Mistress companion-app session for a Principessa Lock admin session.
 *
 * The two products run on separate Supabase projects, so a Vault Mistress JWT means nothing to
 * this backend's `verifyAdminRequest`. Rather than duplicating Vault Mistress's admin rules (or
 * holding its service-role key), this route forwards the token to Vault Mistress's own
 * `/api/admin/mobile/whoami` and treats a 200 as proof that the caller is that admin. It then
 * mints a real Lock session for ADMIN_EMAIL via a single-use magic link, so the companion app
 * never handles the Lock admin password and every downstream route keeps its existing guard.
 *
 * Required environment variables:
 * - VAULT_MISTRESS_BASE_URL: origin of the Vault Mistress deployment.
 * - ADMIN_EMAIL: the Lock admin account this bridge is allowed to mint a session for.
 */
export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many bridge attempts. Please wait before trying again.",
    limit: 20,
    request,
    routeKey: "admin:vault-bridge",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const vaultBaseUrl = process.env.VAULT_MISTRESS_BASE_URL?.trim().replace(/\/+$/, "");
  const adminEmail = process.env.ADMIN_EMAIL?.trim();

  if (!vaultBaseUrl || !adminEmail) {
    return jsonError(500, "Vault Mistress bridge is not configured on this backend.");
  }

  const bodyResult = await readJsonBody<VaultBridgeInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const vaultAccessToken =
    typeof bodyResult.data.vaultAccessToken === "string" ? bodyResult.data.vaultAccessToken.trim() : "";

  if (!vaultAccessToken) {
    return jsonError(400, "vaultAccessToken is required.");
  }

  let whoamiResponse: Response;

  try {
    whoamiResponse = await fetch(`${vaultBaseUrl}/api/admin/mobile/whoami`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${vaultAccessToken}` },
    });
  } catch {
    return jsonError(502, "Vault Mistress could not be reached to verify this session.");
  }

  if (!whoamiResponse.ok) {
    return jsonError(401, "This Vault Mistress session is not an authorized admin session.");
  }

  // Isolated: verifyOtp below signs in, which rebinds this client's PostgREST Authorization
  // header to the minted user session. On the shared admin client that would make every
  // subsequent query in this container run as `authenticated` instead of service_role.
  const supabase = createIsolatedSupabaseClient();

  // generateLink + verifyOtp mints a session without this backend ever storing the admin's
  // password. The link is consumed immediately here and never leaves the server.
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    email: adminEmail,
    type: "magiclink",
  });

  const tokenHash = linkData?.properties?.hashed_token;

  if (linkError || !tokenHash) {
    return jsonError(500, "Lock admin session could not be created.");
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });

  if (sessionError || !sessionData.session) {
    return jsonError(500, "Lock admin session could not be created.");
  }

  return jsonOk({
    ok: true,
    session: {
      accessToken: sessionData.session.access_token,
      refreshToken: sessionData.session.refresh_token,
      expiresAt: sessionData.session.expires_at ?? null,
    },
  });
}
