import { jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateFcmTokenInput, type FcmTokenInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

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
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

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
