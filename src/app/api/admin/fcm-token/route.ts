import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type FcmTokenInput = {
  fcmToken?: string;
};

// Registers whichever physical device the keyholder is currently logged into the in-app admin
// console on -- single-admin model, so this upserts the one row keyed by her Supabase Auth user
// id, replacing whatever token (if any) a previous device had registered.
export async function POST(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "admin-fcm-token");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const bodyResult = await readJsonBody<FcmTokenInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const fcmToken = bodyResult.data.fcmToken;

  if (!fcmToken || typeof fcmToken !== "string") {
    return jsonError(400, "fcmToken is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("admin_push_tokens").upsert({
    admin_user_id: auth.identity.id,
    fcm_token: fcmToken,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return jsonSupabaseError("Failed to register admin FCM token.", error);
  }

  return jsonOk({ ok: true });
}
