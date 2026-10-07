import { notifyAdminDevices } from "@/lib/server/admin-push";
import { jsonError, jsonOk } from "@/lib/server/api-response";
import { generateDeviceSecret, hashDeviceSecret, requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { sendNewRegistrationPush } from "@/lib/server/fcm";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateRegisterInput, type RegisterInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";
import { transferError } from "@/lib/server/access-transfers";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type CreatedSubRow = {
  id: string;
};

type SubStatusRow = {
  status: string;
  access_transfer_id: string | null;
};

type ExistingDeviceRow = {
  access_revoked_at: string | null;
  transfer_protected: boolean;
  device_secret_hash: string | null;
  id: string;
  sub_id: string | null;
  subs: { username: string | null; status: string; access_transfer_id?: string | null } | { username: string | null; status: string; access_transfer_id?: string | null }[] | null;
};

function extractSub(value: ExistingDeviceRow["subs"]) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

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

  const {
    deviceName,
    username,
    timezone,
    hardwareIdHash,
    deviceSecret: suppliedDeviceSecret,
    deviceManufacturer,
    deviceModel,
    androidRelease,
    androidSdkInt,
  } = validation.data;
  const supabase = getSupabaseAdminClient();

  // Recover idempotent registration retries only with the original credential.
  // A known hardware identity is public metadata, not proof of paid-access ownership.
  if (hardwareIdHash) {
    const { data: existingDevice, error: lookupError } = await supabase
      .from("devices")
      .select("id, sub_id, access_revoked_at, transfer_protected, device_secret_hash, subs(username, status, access_transfer_id)")
      .eq("hardware_id_hash", hardwareIdHash)
      .maybeSingle<ExistingDeviceRow>();

    if (lookupError) {
      return jsonSupabaseError("Failed to check for an existing registration.", lookupError);
    }

    if (existingDevice) {
      const existingSub = extractSub(existingDevice.subs);
      if (existingDevice.access_revoked_at || existingSub?.status === "archived") {
        return jsonError(403, "This device no longer has access. Contact Principessa.");
      }
      // A hardware ID is not a credential. Transferred access must never be recoverable
      // by replaying that public identity after the new device has been approved.
      if (!suppliedDeviceSecret ||
          hashDeviceSecret(suppliedDeviceSecret) !== existingDevice.device_secret_hash) {
        return jsonError(403, "This phone already has access, but its secure credential is missing. Use Recover existing access for Principessa's approval.", { recoveryRequired: true });
      }
      const deviceSecret = suppliedDeviceSecret ?? generateDeviceSecret();

      const { error: updateError } = await supabase
        .from("devices")
        .update({
          device_name: deviceName,
          device_secret_created_at: new Date().toISOString(),
          device_secret_hash: hashDeviceSecret(deviceSecret),
          device_secret_rotated_at: new Date().toISOString(),
          timezone: timezone ?? null,
          device_manufacturer: deviceManufacturer ?? null,
          device_model: deviceModel ?? null,
          android_release: androidRelease ?? null,
          android_sdk_int: androidSdkInt ?? null,
        })
        .eq("id", existingDevice.id);

      if (updateError) {
        if (updateError.message?.startsWith("transfer_")) return transferError(updateError);
        if (updateError.code === "23505") {
          return jsonError(409, "That device name is already taken. Choose another and try again.");
        }

        return jsonSupabaseError("Failed to recover the existing registration.", updateError);
      }

      return jsonOk(
        {
          device: {
            deviceSecret,
            id: existingDevice.id,
          },
          ok: true,
          recovered: true,
          status: existingSub?.status ?? "active",
          subId: existingDevice.sub_id,
          username: existingSub?.username ?? null,
        },
        { status: 201 },
      );
    }
  }

  if (!username) {
    return jsonError(400, "username is required for a new registration.");
  }

  // No admin-issued code -- the sub picks a username directly, and both the username and the
  // device name are globally unique going forward (enforced by the case-insensitive unique
  // indexes on subs.username / devices.device_name), so neither can be claimed again once used.
  // Status defaults to "invited" -- the keyholder still has to approve the registration before
  // the device can do anything functional (see requireAuthenticatedDevice's gating).
  const { data: sub, error: subError } = await supabase
    .from("subs")
    .insert({ label: username, username })
    .select("id")
    .single<CreatedSubRow>();

  if (subError) {
    if (subError.code === "23505") {
      return jsonError(409, "That username is already taken. Choose another and try again.");
    }

    return jsonSupabaseError("Failed to register.", subError);
  }

  const deviceSecret = suppliedDeviceSecret ?? generateDeviceSecret();
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .insert({
      device_name: deviceName,
      device_secret_created_at: new Date().toISOString(),
      device_secret_hash: hashDeviceSecret(deviceSecret),
      hardware_id_hash: hardwareIdHash ?? null,
      platform: "android",
      sub_id: sub.id,
      timezone: timezone ?? null,
      device_manufacturer: deviceManufacturer ?? null,
      device_model: deviceModel ?? null,
      android_release: androidRelease ?? null,
      android_sdk_int: androidSdkInt ?? null,
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

  await notifyAdminDevices(token => sendNewRegistrationPush(token, username));

  return jsonOk(
    {
      device: {
        deviceSecret,
        id: device.id,
      },
      ok: true,
      recovered: false,
      status: "invited",
      subId: sub.id,
      username,
    },
    { status: 201 },
  );
}

// Polled while a registration is awaiting keyholder approval -- allowPendingSub lets this one
// succeed even though every other device-authenticated route rejects a pending/archived sub.
export async function GET(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many status checks. Please wait before trying again.",
    limit: 60,
    request,
    routeKey: "register:status",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase, { allowPendingSub: true });

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  if (!deviceAuth.device.subId) {
    return jsonOk({ ok: true, status: "active" });
  }

  const { data, error } = await supabase
    .from("subs")
    .select("status, access_transfer_id")
    .eq("id", deviceAuth.device.subId)
    .maybeSingle<SubStatusRow>();

  if (error) {
    return jsonSupabaseError("Failed to load registration status.", error);
  }

  if (data?.status === "invited" && data.access_transfer_id) {
    const {data: transfer,error: transferLoadError}=await supabase.from("access_transfers")
      .select("status,expires_at").eq("id",data.access_transfer_id).maybeSingle();
    if(transferLoadError) return transferError(transferLoadError);
    if(!transfer) return jsonError(503,"Transfer status is unavailable.");
    if(transfer.status==='pending' && Date.parse(transfer.expires_at)<=Date.now()) {
      return jsonOk({ok:true,status:"archived",transferStatus:"expired"});
    }
  }
  return jsonOk({ ok: true, status: data?.status ?? "active" });
}
