import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateSettingsPinInput, type SettingsPinInput } from "@/lib/server/request-validation";
import { queueSyncConfigPush } from "@/lib/server/remote-action-dispatch";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type SettingsAccessRow = {
  config_version: number;
  device_id: string;
  settings_access_allowed: boolean;
  status: string;
  sub_id: string | null;
  updated_at: string;
};

export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many PIN attempts. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "sessions:settings-access",
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

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const settingsPin = process.env.SETTINGS_PIN;

  if (!settingsPin) {
    return jsonError(503, "No settings PIN has been configured by the keyholder.");
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const ownership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId: deviceAuth.device.id,
    sessionId: id,
    suppliedSupabase: supabase,
  });

  if (!ownership.ok) {
    return ownership.response;
  }

  if (validation.data.pin !== settingsPin) {
    return jsonOk({ ok: true, verified: false });
  }

  const { data: session, error: loadError } = await supabase
    .from("sessions")
    .select("config_version, device_id, settings_access_allowed, status, sub_id, updated_at")
    .eq("id", id)
    .maybeSingle<SettingsAccessRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load session.", loadError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (session.status !== "active") {
    return jsonError(409, "Only an active session can unlock Settings.");
  }

  if (session.settings_access_allowed) {
    return jsonOk({
      ok: true,
      verified: true,
      settingsAccessAllowed: true,
      configVersion: session.config_version,
      updatedAt: session.updated_at,
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from("sessions")
    .update({
      settings_access_allowed: true,
      config_version: session.config_version + 1,
    })
    .eq("id", id)
    .eq("config_version", session.config_version)
    .eq("status", "active")
    .select("config_version, device_id, sub_id, updated_at")
    .maybeSingle<Pick<SettingsAccessRow, "config_version" | "device_id" | "sub_id" | "updated_at">>();

  if (updateError) {
    return jsonSupabaseError("Failed to unlock Settings.", updateError);
  }

  if (!updated) {
    return jsonError(409, "Session changed. Try the PIN again.");
  }

  await queueSyncConfigPush(supabase, {
    deviceId: updated.device_id,
    sessionId: id,
    subId: updated.sub_id,
  });

  return jsonOk({
    ok: true,
    verified: true,
    settingsAccessAllowed: true,
    configVersion: updated.config_version,
    updatedAt: updated.updated_at,
  });
}
