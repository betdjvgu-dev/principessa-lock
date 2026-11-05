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
  const { username, deviceName, hardwareIdHash, deviceSecret } = input.data;
  if (!deviceSecret || !/^[0-9a-f]{64}$/.test(hardwareIdHash ?? "")) {
    return jsonError(400, "Original device details, device identity and a secure credential are required.");
  }
  const db = getSupabaseAdminClient();
  let recoveryUsername = username;
  if (!recoveryUsername) {
    type Sub = { username: string | null; status: string };
    const { data: device, error: lookupError } = await db.from("devices")
      .select("device_name,access_revoked_at,subs(username,status)")
      .eq("hardware_id_hash", hardwareIdHash!)
      .maybeSingle<{ device_name: string; access_revoked_at: string | null; subs: Sub | Sub[] | null }>();
    if (lookupError) return recoveryError({});
    const sub = Array.isArray(device?.subs) ? device.subs[0] : device?.subs;
    if (!device || device.access_revoked_at || sub?.status !== "active" || !sub.username ||
        device.device_name.trim().toLowerCase() !== deviceName.trim().toLowerCase()) {
      return recoveryError({ message: "recovery_unavailable" });
    }
    // Resolve the internal handle server-side, but STILL require the existing SQL
    // admin approval and exact candidate-secret check before returning any identity.
    recoveryUsername = sub.username;
  }
  const { data, error } = await db.rpc("request_device_recovery", {
    p_hardware: hardwareIdHash, p_username: recoveryUsername, p_secret_hash: hashDeviceSecret(deviceSecret),
  });
  if (error) return recoveryError(error);
  if (data?.status === "pending") return jsonError(409,
    "Recovery requested. Waiting for Principessa's approval. Tap Recover / Check again after approval.");
  if (data?.status !== "approved" || !data.deviceId) return recoveryError({});
  return jsonOk({ ok: true, recovered: true, status: "active", username: data.username,
    deviceName: data.deviceName, existingSessionId: data.sessionId,
    device: { id: data.deviceId, deviceSecret } }, { headers: { "Cache-Control": "no-store" } });
}
