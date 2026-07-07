import { jsonError, jsonOk } from "@/lib/server/api-response";
import { hashPairingCode } from "@/lib/server/activation-codes";
import { generateDeviceSecret, hashDeviceSecret } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type PairInput = {
  deviceName: string;
  pairingCode: string;
  timezone?: string;
};

export async function POST(request: Request) {
  const rateLimitError = enforceRateLimit({
    errorMessage: "Too many pairing attempts. Please wait before trying again.",
    limit: 20,
    request,
    routeKey: "pair:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<PairInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const pairingCode = typeof bodyResult.data.pairingCode === "string" ? bodyResult.data.pairingCode.trim() : "";
  const deviceName = typeof bodyResult.data.deviceName === "string" ? bodyResult.data.deviceName.trim() : "";
  const timezone = typeof bodyResult.data.timezone === "string" ? bodyResult.data.timezone.trim() || null : null;

  if (!pairingCode) {
    return jsonError(400, "pairingCode is required.");
  }

  if (!deviceName) {
    return jsonError(400, "deviceName is required.");
  }

  const supabase = getSupabaseAdminClient();
  const pairingCodeHash = hashPairingCode(pairingCode);
  const nowIso = new Date().toISOString();

  const { data: claimedSub, error: claimError } = await supabase
    .from("subs")
    .update({
      pairing_code_expires_at: null,
      pairing_code_hash: null,
      status: "active",
    })
    .eq("pairing_code_hash", pairingCodeHash)
    .gt("pairing_code_expires_at", nowIso)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (claimError) {
    return jsonSupabaseError("Failed to claim pairing code.", claimError);
  }

  if (!claimedSub) {
    const { data: existingSub, error: lookupError } = await supabase
      .from("subs")
      .select("id")
      .eq("pairing_code_hash", pairingCodeHash)
      .maybeSingle<{ id: string }>();

    if (lookupError) {
      return jsonSupabaseError("Failed to load pairing code.", lookupError);
    }

    if (existingSub) {
      return jsonError(410, "Pairing code has expired.");
    }

    return jsonError(404, "Invalid pairing code.");
  }

  const deviceSecret = generateDeviceSecret();

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .insert({
      device_name: deviceName,
      device_secret_created_at: new Date().toISOString(),
      device_secret_hash: hashDeviceSecret(deviceSecret),
      platform: "android",
      sub_id: claimedSub.id,
      timezone,
    })
    .select("id")
    .single<{ id: string }>();

  if (deviceError) {
    return jsonSupabaseError("Failed to create device.", deviceError);
  }

  return jsonOk({
    device: {
      deviceSecret,
      id: device.id,
    },
    ok: true,
    subId: claimedSub.id,
  });
}
