import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { generatePairingCode, hashPairingCode } from "@/lib/server/activation-codes";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type SubRow = {
  id: string;
  status: string;
};

async function generateUniquePairingCode(supabase: ReturnType<typeof getSupabaseAdminClient>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const pairingCode = generatePairingCode();
    const pairingCodeHash = hashPairingCode(pairingCode);
    const { data, error } = await supabase
      .from("subs")
      .select("id")
      .eq("pairing_code_hash", pairingCodeHash)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return { pairingCode, pairingCodeHash };
    }
  }

  throw new Error("Unable to generate a unique pairing code.");
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Sub id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: sub, error: loadError } = await supabase
    .from("subs")
    .select("id, status")
    .eq("id", id)
    .maybeSingle<SubRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load sub.", loadError);
  }

  if (!sub) {
    return jsonError(404, "Sub not found.");
  }

  if (sub.status === "archived") {
    return jsonError(409, "Cannot generate a pairing code for an archived sub.");
  }

  let uniqueCode: { pairingCode: string; pairingCodeHash: string };

  try {
    uniqueCode = await generateUniquePairingCode(supabase);
  } catch (error) {
    if (error instanceof Error) {
      return jsonError(500, error.message);
    }

    return jsonError(500, "Failed to generate a unique pairing code.");
  }

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const { error: updateError } = await supabase
    .from("subs")
    .update({
      pairing_code_expires_at: expiresAt,
      pairing_code_hash: uniqueCode.pairingCodeHash,
    })
    .eq("id", id);

  if (updateError) {
    return jsonSupabaseError("Failed to store pairing code.", updateError);
  }

  return jsonOk({
    ok: true,
    pairingCode: uniqueCode.pairingCode,
    pairingCodeExpiresAt: expiresAt,
  });
}
