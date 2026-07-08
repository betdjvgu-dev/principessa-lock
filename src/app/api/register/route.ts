import { jsonError, jsonOk } from "@/lib/server/api-response";
import { generateDeviceSecret, hashDeviceSecret } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateRegisterInput, type RegisterInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type CreatedSubRow = {
  id: string;
};

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many registration attempts. Please wait before trying again.",
    limit: 20,
    request,
    routeKey: "register:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<RegisterInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateRegisterInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const { deviceName, username, timezone } = validation.data;
  const supabase = getSupabaseAdminClient();

  // No admin-issued code -- the sub picks a username directly, and both the username and the
  // device name are globally unique going forward (enforced by the case-insensitive unique
  // indexes on subs.username / devices.device_name), so neither can be claimed again once used.
  const { data: sub, error: subError } = await supabase
    .from("subs")
    .insert({ label: username, status: "active", username })
    .select("id")
    .single<CreatedSubRow>();

  if (subError) {
    if (subError.code === "23505") {
      return jsonError(409, "That username is already taken. Choose another and try again.");
    }

    return jsonSupabaseError("Failed to register.", subError);
  }

  const deviceSecret = generateDeviceSecret();
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .insert({
      device_name: deviceName,
      device_secret_created_at: new Date().toISOString(),
      device_secret_hash: hashDeviceSecret(deviceSecret),
      platform: "android",
      sub_id: sub.id,
      timezone: timezone ?? null,
    })
    .select("id")
    .single<{ id: string }>();

  if (deviceError) {
    // The sub row is now unrecoverable garbage (device creation failed) -- clean it up rather
    // than leaving a dead row that's still holding the username reservation.
    await supabase.from("subs").delete().eq("id", sub.id);

    if (deviceError.code === "23505") {
      return jsonError(409, "That device name is already taken. Choose another and try again.");
    }

    return jsonSupabaseError("Failed to register device.", deviceError);
  }

  return jsonOk(
    {
      device: {
        deviceSecret,
        id: device.id,
      },
      ok: true,
      subId: sub.id,
      username,
    },
    { status: 201 },
  );
}
