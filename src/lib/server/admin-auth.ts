import "server-only";

import { jsonError } from "@/lib/server/api-response";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

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
 * admin identity for this product, so `ADMIN_EMAIL` (optional) is a cheap
 * belt-and-suspenders check rather than a real multi-tenant authorization rule.
 */
export async function verifyAdminRequest(
  request: Request,
): Promise<{ error: Response; identity?: undefined } | { error?: undefined; identity: AdminIdentity }> {
  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return { error: jsonError(401, "Missing or invalid admin bearer token.") };
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return { error: jsonError(401, "Invalid or expired admin session.") };
  }

  const adminEmail = process.env.ADMIN_EMAIL;

  if (adminEmail && data.user.email?.toLowerCase() !== adminEmail.toLowerCase()) {
    return { error: jsonError(403, "This account is not authorized as the admin.") };
  }

  return { identity: { id: data.user.id, email: data.user.email ?? null } };
}
