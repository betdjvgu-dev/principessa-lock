import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type HardwareIdInput = {
  hardwareIdHash?: string;
};

// Backfills hardware_id_hash for devices registered before device-recovery-on-reinstall existed
// (see /api/register) -- called once at app startup for an already-paired device so its *next*
// reinstall gets recognized too, not just registrations made after this endpoint shipped.
// allowPendingSub because this should work for a still-pending registration as well.
export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many requests. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "devices:hardware-id",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<HardwareIdInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hardwareIdHash = typeof bodyResult.data?.hardwareIdHash === "string" ? bodyResult.data.hardwareIdHash.trim() : "";

  if (!hardwareIdHash) {
    return jsonError(400, "hardwareIdHash is required.");
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase, { allowPendingSub: true });

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const { error: updateError } = await supabase
    .from("devices")
    .update({ hardware_id_hash: hardwareIdHash })
    .eq("id", deviceAuth.device.id);

  if (updateError) {
    // Another device already claims this hash (shouldn't happen in practice) -- non-fatal, this
    // is a best-effort backfill.
    if (updateError.code === "23505") {
      return jsonOk({ ok: true });
    }

    return jsonSupabaseError("Failed to store hardware id.", updateError);
  }

  return jsonOk({ ok: true });
}
