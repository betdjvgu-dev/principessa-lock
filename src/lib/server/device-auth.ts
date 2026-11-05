import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { jsonError } from "@/lib/server/api-response";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseReadError } from "@/lib/server/supabase-errors";
import { retrySupabaseRead } from "./retry-supabase-read";
import { AccessLicenseError, accessLicenseError, automaticAccessUsername, codeRegistrationEnabled, verifyAccessLicense } from "./access-licenses";

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdminClient>;

type DeviceAuthRow = {
  access_revoked_at: string | null;
  device_name: string;
  device_secret_hash: string | null;
  id: string;
  sub_id: string | null;
  subs: { status: string; username?: string; label?: string } | { status: string; username?: string; label?: string }[] | null;
};

function extractSubStatus(value: DeviceAuthRow["subs"]) {
  if (Array.isArray(value)) {
    return value[0]?.status ?? null;
  }

  return value?.status ?? null;
}

type SessionOwnershipRow = {
  device_id: string;
  id: string;
};

type RemoteActionOwnershipRow = {
  device_id: string | null;
  id: string;
  session_id: string;
};

type DeviceAuthSuccess = {
  ok: true;
  device: {
    deviceName: string;
    id: string;
    subId: string | null;
  };
  accessRevoked?: boolean;
};

type DeviceAuthFailure = {
  ok: false;
  response: Response;
};

function extractBearerToken(authorizationHeader: string | null) {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token.trim();
}

export function generateDeviceSecret() {
  return `plock_${randomBytes(32).toString("base64url")}`;
}

export function hashDeviceSecret(deviceSecret: string) {
  return createHash("sha256").update(deviceSecret).digest("hex");
}

export async function requireAuthenticatedDevice(
  request: Request,
  suppliedSupabase?: SupabaseAdminClient,
  options?: { allowPendingSub?: boolean; existingSessionRead?: boolean },
): Promise<DeviceAuthSuccess | DeviceAuthFailure> {
  const deviceSecret = extractBearerToken(request.headers.get("authorization"));

  if (!deviceSecret) {
    return {
      ok: false,
      response: jsonError(401, "Missing or invalid device bearer token."),
    };
  }

  const supabase = suppliedSupabase ?? getSupabaseAdminClient();
  const { data: device, error } = await retrySupabaseRead(() => supabase
    .from("devices")
    .select("id, device_name, device_secret_hash, sub_id, access_revoked_at, subs(status,username,label)")
    .eq("device_secret_hash", hashDeviceSecret(deviceSecret))
    .maybeSingle<DeviceAuthRow>());

  if (error) {
    return {
      ok: false,
      response: jsonSupabaseReadError("Failed to verify device authorization.", error),
    };
  }

  if (!device?.device_secret_hash || device.access_revoked_at) {
    return {
      ok: false,
      response: jsonError(401, "Invalid device bearer token."),
    };
  }

  // Pending legacy registrations/transfers cannot use protected APIs. Code activation
  // creates active access atomically; the lifetime entitlement is checked separately below.
  const subStatus = extractSubStatus(device.subs);

  if (!options?.allowPendingSub && subStatus !== null && subStatus !== "active") {
    return {
      ok: false,
      response:
        subStatus === "invited"
          ? jsonError(403, "Registration is pending keyholder approval.")
          : jsonError(403, "Registration was not approved."),
    };
  }

  if (codeRegistrationEnabled() && (!device.sub_id || !subStatus)) {
    return { ok: false, response: jsonError(503, "This device's access account needs admin review. Saved credentials have not been removed.") };
  }
  let accessRevoked = false;
  if (codeRegistrationEnabled() && subStatus === "active" && device.sub_id) {
    try { await verifyAccessLicense(device.sub_id, device.id, options?.existingSessionRead); }
    catch (error) {
      if (options?.existingSessionRead && error instanceof AccessLicenseError && error.reason === "revoked") accessRevoked = true;
      else return { ok: false, response: accessLicenseError(error, device.id) };
    }
  }

  const sub = Array.isArray(device.subs) ? device.subs[0] : device.subs;
  if (!accessRevoked && sub?.username && sub.label === sub.username && [0, 1, 2].some(
    attempt => automaticAccessUsername(device.device_name, deviceSecret, attempt) === sub.username,
  )) {
    // Display-only repair must never prevent an existing customer from authenticating.
    await supabase.rpc("repair_lock_generated_label", { p_device: device.id, p_username: sub.username }).then(() => {}, () => {});
  }

  return {
    ok: true,
    accessRevoked,
    device: {
      deviceName: device.device_name,
      id: device.id,
      subId: device.sub_id,
    },
  };
}

export async function verifySessionOwnershipForDevice({
  authenticatedDeviceId,
  claimedDeviceId,
  sessionId,
  suppliedSupabase,
}: {
  authenticatedDeviceId: string;
  claimedDeviceId?: string;
  sessionId: string;
  suppliedSupabase?: SupabaseAdminClient;
}): Promise<
  | {
      ok: true;
      session: SessionOwnershipRow;
    }
  | DeviceAuthFailure
> {
  if (claimedDeviceId && claimedDeviceId !== authenticatedDeviceId) {
    return {
      ok: false,
      response: jsonError(403, "Authenticated device does not match the provided device id."),
    };
  }

  const supabase = suppliedSupabase ?? getSupabaseAdminClient();
  const { data: session, error } = await retrySupabaseRead(() => supabase
    .from("sessions")
    .select("id, device_id")
    .eq("id", sessionId)
    .maybeSingle<SessionOwnershipRow>());

  if (error) {
    return {
      ok: false,
      response: jsonSupabaseReadError("Failed to verify session ownership.", error),
    };
  }

  if (!session) {
    return {
      ok: false,
      response: jsonError(404, "Session not found."),
    };
  }

  if (session.device_id !== authenticatedDeviceId) {
    return {
      ok: false,
      response: jsonError(403, "Authenticated device is not allowed to access this session."),
    };
  }

  return {
    ok: true,
    session,
  };
}

export async function verifyRemoteActionOwnershipForDevice({
  actionId,
  authenticatedDeviceId,
  suppliedSupabase,
}: {
  actionId: string;
  authenticatedDeviceId: string;
  suppliedSupabase?: SupabaseAdminClient;
}): Promise<
  | {
      ok: true;
      action: RemoteActionOwnershipRow;
    }
  | DeviceAuthFailure
> {
  const supabase = suppliedSupabase ?? getSupabaseAdminClient();
  const { data: action, error } = await supabase
    .from("device_remote_actions")
    .select("id, session_id, device_id")
    .eq("id", actionId)
    .maybeSingle<RemoteActionOwnershipRow>();

  if (error) {
    return {
      ok: false,
      response: jsonSupabaseReadError("Failed to verify remote action ownership.", error),
    };
  }

  if (!action) {
    return {
      ok: false,
      response: jsonError(404, "Remote action not found."),
    };
  }

  const sessionOwnership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId,
    claimedDeviceId: action.device_id ?? undefined,
    sessionId: action.session_id,
    suppliedSupabase: supabase,
  });

  if (!sessionOwnership.ok) {
    return sessionOwnership;
  }

  return {
    ok: true,
    action,
  };
}
