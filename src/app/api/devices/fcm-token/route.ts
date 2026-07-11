import { jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateFcmTokenInput, type FcmTokenInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many token registration attempts. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "devices:fcm-token",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<FcmTokenInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateFcmTokenInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  // Must work even while a registration is pending approval -- otherwise a pending sub could
  // never register the token needed to receive the "registration approved" push in the first
  // place (see sendRegistrationApprovedPush in fcm.ts).
  const deviceAuth = await requireAuthenticatedDevice(request, supabase, { allowPendingSub: true });

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const { error: updateError } = await supabase
    .from("devices")
    .update({ fcm_token: validation.data.fcmToken })
    .eq("id", deviceAuth.device.id);

  if (updateError) {
    return jsonSupabaseError("Failed to store the FCM token.", updateError);
  }

  return jsonOk({ ok: true });
}
