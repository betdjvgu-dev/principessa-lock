import { jsonError, jsonOk } from "@/lib/server/api-response";
import { hashDeviceSecret } from "@/lib/server/device-auth";
import { recoveryError } from "@/lib/server/device-recovery";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateRegisterInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = await enforceRateLimit({ request, routeKey: "device:recovery", limit: 10,
    windowMs: 15 * 60 * 1000, errorMessage: "Too many recovery checks. Please wait." });
  if (limited) return limited;
  const body = await readJsonBody<unknown>(request);
  if (!body.ok) return body.response;
  const input = validateRegisterInput(body.data);
  if (!input.ok) return input.response;
  const { username, hardwareIdHash, deviceSecret } = input.data;
  if (!username || !deviceSecret || !/^[0-9a-f]{64}$/.test(hardwareIdHash ?? "")) {
    return jsonError(400, "Original username, device identity and a secure credential are required.");
  }
  const { data, error } = await getSupabaseAdminClient().rpc("request_device_recovery", {
    p_hardware: hardwareIdHash, p_username: username, p_secret_hash: hashDeviceSecret(deviceSecret),
  });
  if (error) return recoveryError(error);
  if (data?.status === "pending") return jsonError(409,
    "Recovery requested. Waiting for Principessa's approval. Tap Recover / Check again after approval.");
  if (data?.status !== "approved" || !data.deviceId) return recoveryError({});
  return jsonOk({ ok: true, recovered: true, status: "active", username: data.username,
    deviceName: data.deviceName, existingSessionId: data.sessionId,
    device: { id: data.deviceId, deviceSecret } }, { headers: { "Cache-Control": "no-store" } });
}
