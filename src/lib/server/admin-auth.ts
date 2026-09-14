import "server-only";

import { jsonError } from "@/lib/server/api-response";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { adminAuthFailure } from "./admin-auth-errors";
import { authorizeAdminEmail, requireAdminConfiguration } from "./admin-identity";

function extractBearerToken(authorizationHeader: string | null) {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

export type AdminIdentity = {
  id: string;
  email: string | null;
};

/**
 * Verifies the keyholder's Supabase Auth session token. There is exactly one
 * admin identity for this product. Missing ADMIN_EMAIL always denies access.
 */
export async function verifyAdminRequest(
  request: Request,
): Promise<{ error: Response; identity?: undefined } | { error?: undefined; identity: AdminIdentity }> {
  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return { error: jsonError(401, "Missing or invalid admin bearer token.") };
  }

  const configurationError = requireAdminConfiguration();
  if (configurationError) return { error: configurationError };

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.auth.getUser(token)
    .catch((error: unknown) => ({ data: null, error }));

  if (error || !data?.user) {
    return { error: adminAuthFailure(error, "Invalid or expired admin session.") };
  }

  const identityError = authorizeAdminEmail(data.user.email);
  if (identityError) return { error: identityError };

  return { identity: { id: data.user.id, email: data.user.email ?? null } };
}
