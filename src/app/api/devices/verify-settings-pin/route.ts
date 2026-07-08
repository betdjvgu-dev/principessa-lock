import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateSettingsPinInput, type SettingsPinInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many PIN attempts. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "devices:verify-settings-pin",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<SettingsPinInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateSettingsPinInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const settingsPin = process.env.SETTINGS_PIN;

  if (!settingsPin) {
    return jsonError(503, "No settings PIN has been configured by the keyholder.");
  }

  return jsonOk({
    ok: true,
    verified: validation.data.pin === settingsPin,
  });
}
