import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { jsonError } from "@/lib/server/api-response";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdminClient>;

type DeviceAuthRow = {
  device_secret_hash: string | null;
  id: string;
};

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
    id: string;
  };
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
): Promise<DeviceAuthSuccess | DeviceAuthFailure> {
  const deviceSecret = extractBearerToken(request.headers.get("authorization"));

  if (!deviceSecret) {
    return {
      ok: false,
      response: jsonError(401, "Missing or invalid device bearer token."),
    };
  }

  const supabase = suppliedSupabase ?? getSupabaseAdminClient();
  const { data: device, error } = await supabase
    .from("devices")
    .select("id, device_secret_hash")
    .eq("device_secret_hash", hashDeviceSecret(deviceSecret))
    .maybeSingle<DeviceAuthRow>();

  if (error) {
    return {
      ok: false,
      response: jsonSupabaseError("Failed to verify device authorization.", error),
    };
  }

  if (!device?.device_secret_hash) {
    return {
      ok: false,
      response: jsonError(401, "Invalid device bearer token."),
    };
  }

  return {
    ok: true,
    device: {
      id: device.id,
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
  const { data: session, error } = await supabase
    .from("sessions")
    .select("id, device_id")
    .eq("id", sessionId)
    .maybeSingle<SessionOwnershipRow>();

  if (error) {
    return {
      ok: false,
      response: jsonSupabaseError("Failed to verify session ownership.", error),
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
      response: jsonSupabaseError("Failed to verify remote action ownership.", error),
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
